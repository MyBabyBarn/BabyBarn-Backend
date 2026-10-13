import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { writeAdminAudit } from './audit.service.js';
import {
  authorLabel,
  parseSeenBlogSlugs,
  readingTimeMinutes,
  seenBlogCookieValue,
  slugifyBlog,
} from '../lib/blog-format.js';

const POST_INCLUDE = {
  categories: { include: { category: true } },
  tags: { include: { tag: true } },
  createdBy: { select: { publicId: true, email: true, firstName: true, lastName: true } },
  updatedBy: { select: { publicId: true, email: true, firstName: true, lastName: true } },
};

function actorOf(user) {
  return {
    actorId: user?.id ?? user?.publicId ?? null,
    actorEmail: user?.email ?? null,
  };
}

async function staffUserId(user) {
  const publicId = user?.id || user?.publicId;
  if (!publicId) return null;
  const row = await prisma.user.findUnique({ where: { publicId: String(publicId) }, select: { id: true } });
  return row?.id ?? null;
}

function taxonomies(post) {
  return {
    categories: (post.categories || []).map((row) => ({
      id: row.category.publicId,
      name: row.category.name,
      slug: row.category.slug,
    })),
    tags: (post.tags || []).map((row) => ({
      id: row.tag.publicId,
      name: row.tag.name,
      slug: row.tag.slug,
    })),
  };
}

function toCard(post) {
  const tax = taxonomies(post);
  return {
    id: post.publicId,
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    featuredImageUrl: post.featuredImageUrl,
    featuredImageAlt: post.featuredImageAlt,
    authorName: post.authorName,
    publishedAt: post.publishedAt,
    updatedAt: post.updatedAt,
    readingTimeMinutes: readingTimeMinutes(post.contentHtml || post.excerpt),
    viewCount: post.viewCount,
    featured: post.featured,
    categories: tax.categories,
    tags: tax.tags,
  };
}

function toAdmin(post) {
  return {
    ...toCard(post),
    contentHtml: post.contentHtml,
    status: post.status,
    scheduledAt: post.scheduledAt,
    seoTitle: post.seoTitle,
    metaDescription: post.metaDescription,
    ogTitle: post.ogTitle,
    ogDescription: post.ogDescription,
    ogImageUrl: post.ogImageUrl,
    canonicalUrl: post.canonicalUrl,
    createdAt: post.createdAt,
    createdBy: authorLabel(post.createdBy),
    updatedBy: authorLabel(post.updatedBy),
  };
}

function publishedWhere(now = new Date()) {
  return {
    deletedAt: null,
    status: 'PUBLISHED',
    publishedAt: { lte: now },
  };
}

/** Max featured articles on the storefront hero (and admin starring). */
export const BLOG_FEATURED_LIMIT = 3;

async function assertFeaturedSlotAvailable(excludePostId) {
  const count = await prisma.blogPost.count({
    where: {
      deletedAt: null,
      featured: true,
      ...(excludePostId ? { id: { not: excludePostId } } : {}),
    },
  });
  if (count >= BLOG_FEATURED_LIMIT) {
    throw new AppError(
      400,
      `Only ${BLOG_FEATURED_LIMIT} featured articles are allowed. Unfeature another article first.`,
      'FEATURED_LIMIT'
    );
  }
}

async function uniqueLiveSlug(base, ignoreId) {
  let slug = slugifyBlog(base);
  let n = 1;
  while (true) {
    const existing = await prisma.blogPost.findFirst({
      where: {
        slug,
        deletedAt: null,
        ...(ignoreId ? { NOT: { id: ignoreId } } : {}),
      },
      select: { id: true },
    });
    if (!existing) return slug;
    n += 1;
    slug = `${slugifyBlog(base).slice(0, 70)}-${n}`;
  }
}

async function resolveCategoryIds(publicIds) {
  if (!publicIds?.length) return [];
  const rows = await prisma.blogCategory.findMany({
    where: { publicId: { in: publicIds } },
    select: { id: true, publicId: true },
  });
  if (rows.length !== publicIds.length) {
    throw new AppError(400, 'One or more categories were not found');
  }
  return rows.map((r) => r.id);
}

async function resolveTagIds(publicIds) {
  if (!publicIds?.length) return [];
  const rows = await prisma.blogTag.findMany({
    where: { publicId: { in: publicIds } },
    select: { id: true },
  });
  if (rows.length !== publicIds.length) {
    throw new AppError(400, 'One or more tags were not found');
  }
  return rows.map((r) => r.id);
}

/** Persist body images as stable `/uploads/...` paths (not host-absolute). */
function normalizeContentHtml(html) {
  return String(html || '').replace(
    /(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi,
    (_full, pre, src, post) => {
      const match = String(src).replace(/\\/g, '/').match(/(\/uploads\/.+)$/i);
      return `${pre}${match ? match[1] : src}${post}`;
    }
  );
}

function cleanText(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

async function loadPost(publicId) {
  const post = await prisma.blogPost.findFirst({
    where: { publicId, deletedAt: null },
    include: POST_INCLUDE,
  });
  if (!post) throw new AppError(404, 'Article not found');
  return post;
}

async function setTaxonomies(postId, categoryIds, tagIds) {
  await prisma.blogPostCategory.deleteMany({ where: { postId } });
  await prisma.blogPostTag.deleteMany({ where: { postId } });
  if (categoryIds.length) {
    await prisma.blogPostCategory.createMany({
      data: categoryIds.map((categoryId) => ({ postId, categoryId })),
    });
  }
  if (tagIds.length) {
    await prisma.blogPostTag.createMany({
      data: tagIds.map((tagId) => ({ postId, tagId })),
    });
  }
}

export async function listAdminPosts({ search, status, category, tag, featured, page = 1, limit = 20 }) {
  const take = Math.min(50, Math.max(1, Number(limit) || 20));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;
  const where = { deletedAt: null };
  // UI “Unpublished” = DRAFT that was previously published (publishedAt set). Pure drafts have null publishedAt.
  if (status === 'UNPUBLISHED') {
    where.status = 'DRAFT';
    where.publishedAt = { not: null };
  } else if (status === 'DRAFT') {
    where.status = 'DRAFT';
    where.publishedAt = null;
  } else if (status && ['SCHEDULED', 'PUBLISHED'].includes(status)) {
    where.status = status;
  }
  if (featured === 'true' || featured === true) where.featured = true;
  if (featured === 'false') where.featured = false;
  if (search && String(search).trim()) {
    const q = String(search).trim();
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { authorName: { contains: q, mode: 'insensitive' } },
      { slug: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (category) {
    where.categories = { some: { category: { slug: String(category) } } };
  }
  if (tag) {
    where.tags = { some: { tag: { slug: String(tag) } } };
  }
  const countWhere = { deletedAt: null };
  if (featured === 'true' || featured === true) countWhere.featured = true;
  if (featured === 'false') countWhere.featured = false;
  if (search && String(search).trim()) {
    const q = String(search).trim();
    countWhere.OR = where.OR;
  }
  if (category) countWhere.categories = where.categories;
  if (tag) countWhere.tags = where.tags;

  const [rows, total, grouped, draftOnly, unpublished] = await Promise.all([
    prisma.blogPost.findMany({
      where,
      include: POST_INCLUDE,
      orderBy: [{ updatedAt: 'desc' }],
      skip,
      take,
    }),
    prisma.blogPost.count({ where }),
    prisma.blogPost.groupBy({
      by: ['status'],
      where: countWhere,
      _count: { _all: true },
    }),
    prisma.blogPost.count({ where: { ...countWhere, status: 'DRAFT', publishedAt: null } }),
    prisma.blogPost.count({ where: { ...countWhere, status: 'DRAFT', publishedAt: { not: null } } }),
  ]);
  const statusCounts = { ALL: 0, DRAFT: 0, SCHEDULED: 0, PUBLISHED: 0, UNPUBLISHED: 0 };
  for (const row of grouped) {
    if (row.status === 'DRAFT') continue;
    statusCounts[row.status] = row._count._all;
    statusCounts.ALL += row._count._all;
  }
  statusCounts.DRAFT = draftOnly;
  statusCounts.UNPUBLISHED = unpublished;
  statusCounts.ALL += draftOnly + unpublished;
  return {
    items: rows.map(toAdmin),
    statusCounts,
    pagination: { page: Math.max(1, Number(page) || 1), limit: take, total, pages: Math.ceil(total / take) || 1 },
  };
}

export async function getAdminPost(publicId) {
  return toAdmin(await loadPost(publicId));
}

export async function createPost(user, body) {
  const title = cleanText(body.title, 180);
  if (!title) throw new AppError(400, 'Title is required');
  const slug = await uniqueLiveSlug(body.slug || title);
  const userId = await staffUserId(user);
  const categoryIds = await resolveCategoryIds(body.categoryIds || []);
  const tagIds = await resolveTagIds(body.tagIds || []);
  const wantFeatured = Boolean(body.featured);
  if (wantFeatured) await assertFeaturedSlotAvailable();
  const post = await prisma.blogPost.create({
    data: {
      slug,
      title,
      excerpt: cleanText(body.excerpt, 400) || '',
      contentHtml: normalizeContentHtml(body.contentHtml || ''),
      featuredImageUrl: cleanText(body.featuredImageUrl, 500),
      featuredImageAlt: cleanText(body.featuredImageAlt, 180),
      authorName: cleanText(body.authorName, 120) || authorLabel(user) || 'Baby Barn',
      featured: wantFeatured,
      seoTitle: cleanText(body.seoTitle, 70),
      metaDescription: cleanText(body.metaDescription, 180),
      ogTitle: cleanText(body.ogTitle, 90),
      ogDescription: cleanText(body.ogDescription, 200),
      ogImageUrl: cleanText(body.ogImageUrl, 500),
      canonicalUrl: cleanText(body.canonicalUrl, 300),
      createdById: userId,
      updatedById: userId,
      status: 'DRAFT',
    },
    include: POST_INCLUDE,
  });
  await setTaxonomies(post.id, categoryIds, tagIds);
  const fresh = await loadPost(post.publicId);
  await writeAdminAudit({
    ...actorOf(user),
    action: 'BLOG_CREATED',
    entityType: 'BlogPost',
    entityId: fresh.publicId,
    meta: { slug: fresh.slug },
  });
  return toAdmin(fresh);
}

export async function updatePost(user, publicId, body) {
  const existing = await loadPost(publicId);
  const title = body.title != null ? cleanText(body.title, 180) : existing.title;
  if (!title) throw new AppError(400, 'Title is required');
  const slug =
    body.slug != null && String(body.slug).trim() && slugifyBlog(body.slug) !== existing.slug
      ? await uniqueLiveSlug(body.slug, existing.id)
      : existing.slug;
  const userId = await staffUserId(user);
  const data = {
    title,
    slug,
    updatedById: userId,
  };
  if (body.excerpt != null) data.excerpt = cleanText(body.excerpt, 400) || '';
  if (body.contentHtml != null) data.contentHtml = normalizeContentHtml(body.contentHtml);
  if (body.featuredImageUrl !== undefined) data.featuredImageUrl = cleanText(body.featuredImageUrl, 500);
  if (body.featuredImageAlt !== undefined) data.featuredImageAlt = cleanText(body.featuredImageAlt, 180);
  if (body.authorName != null) data.authorName = cleanText(body.authorName, 120) || 'Baby Barn';
  if (body.featured != null) {
    const wantFeatured = Boolean(body.featured);
    if (wantFeatured && !existing.featured) await assertFeaturedSlotAvailable(existing.id);
    data.featured = wantFeatured;
  }
  if (body.seoTitle !== undefined) data.seoTitle = cleanText(body.seoTitle, 70);
  if (body.metaDescription !== undefined) data.metaDescription = cleanText(body.metaDescription, 180);
  if (body.ogTitle !== undefined) data.ogTitle = cleanText(body.ogTitle, 90);
  if (body.ogDescription !== undefined) data.ogDescription = cleanText(body.ogDescription, 200);
  if (body.ogImageUrl !== undefined) data.ogImageUrl = cleanText(body.ogImageUrl, 500);
  if (body.canonicalUrl !== undefined) data.canonicalUrl = cleanText(body.canonicalUrl, 300);

  await prisma.blogPost.update({ where: { id: existing.id }, data });
  if (Array.isArray(body.categoryIds)) {
    await setTaxonomies(
      existing.id,
      await resolveCategoryIds(body.categoryIds),
      Array.isArray(body.tagIds) ? await resolveTagIds(body.tagIds) : existing.tags.map((t) => t.tagId)
    );
  } else if (Array.isArray(body.tagIds)) {
    await prisma.blogPostTag.deleteMany({ where: { postId: existing.id } });
    const tagIds = await resolveTagIds(body.tagIds);
    if (tagIds.length) {
      await prisma.blogPostTag.createMany({ data: tagIds.map((tagId) => ({ postId: existing.id, tagId })) });
    }
  }
  const fresh = await loadPost(publicId);
  await writeAdminAudit({
    ...actorOf(user),
    action: 'BLOG_UPDATED',
    entityType: 'BlogPost',
    entityId: fresh.publicId,
    meta: { slug: fresh.slug },
  });
  return toAdmin(fresh);
}

export async function deletePost(user, publicId) {
  const existing = await loadPost(publicId);
  await prisma.blogPost.update({
    where: { id: existing.id },
    data: { deletedAt: new Date(), featured: false, updatedById: await staffUserId(user) },
  });
  await writeAdminAudit({
    ...actorOf(user),
    action: 'BLOG_DELETED',
    entityType: 'BlogPost',
    entityId: existing.publicId,
    meta: { slug: existing.slug },
  });
  return { id: existing.publicId };
}

export async function duplicatePost(user, publicId) {
  const existing = await loadPost(publicId);
  const slug = await uniqueLiveSlug(`${existing.slug}-copy`);
  const userId = await staffUserId(user);
  const copy = await prisma.blogPost.create({
    data: {
      slug,
      title: `${existing.title} (copy)`.slice(0, 180),
      excerpt: existing.excerpt,
      contentHtml: existing.contentHtml,
      featuredImageUrl: existing.featuredImageUrl,
      featuredImageAlt: existing.featuredImageAlt,
      authorName: existing.authorName,
      featured: false,
      status: 'DRAFT',
      seoTitle: existing.seoTitle,
      metaDescription: existing.metaDescription,
      ogTitle: existing.ogTitle,
      ogDescription: existing.ogDescription,
      ogImageUrl: existing.ogImageUrl,
      canonicalUrl: null,
      createdById: userId,
      updatedById: userId,
    },
  });
  await setTaxonomies(
    copy.id,
    existing.categories.map((c) => c.categoryId),
    existing.tags.map((t) => t.tagId)
  );
  const fresh = await loadPost(copy.publicId);
  await writeAdminAudit({
    ...actorOf(user),
    action: 'BLOG_DUPLICATED',
    entityType: 'BlogPost',
    entityId: fresh.publicId,
    meta: { from: existing.publicId, slug: fresh.slug },
  });
  return toAdmin(fresh);
}

export async function publishPost(user, publicId) {
  const existing = await loadPost(publicId);
  const now = new Date();
  await prisma.blogPost.update({
    where: { id: existing.id },
    data: {
      status: 'PUBLISHED',
      publishedAt: existing.publishedAt || now,
      scheduledAt: null,
      updatedById: await staffUserId(user),
    },
  });
  const fresh = await loadPost(publicId);
  await writeAdminAudit({
    ...actorOf(user),
    action: 'BLOG_PUBLISHED',
    entityType: 'BlogPost',
    entityId: fresh.publicId,
    meta: { slug: fresh.slug },
  });
  return toAdmin(fresh);
}

export async function unpublishPost(user, publicId) {
  const existing = await loadPost(publicId);
  await prisma.blogPost.update({
    where: { id: existing.id },
    data: { status: 'DRAFT', scheduledAt: null, updatedById: await staffUserId(user) },
  });
  const fresh = await loadPost(publicId);
  await writeAdminAudit({
    ...actorOf(user),
    action: 'BLOG_UNPUBLISHED',
    entityType: 'BlogPost',
    entityId: fresh.publicId,
    meta: { slug: fresh.slug },
  });
  return toAdmin(fresh);
}

export async function schedulePost(user, publicId, scheduledAtRaw) {
  const existing = await loadPost(publicId);
  const scheduledAt = new Date(scheduledAtRaw);
  if (Number.isNaN(scheduledAt.getTime())) throw new AppError(400, 'Choose a valid publish date and time');
  if (scheduledAt.getTime() <= Date.now()) throw new AppError(400, 'Schedule time must be in the future');
  await prisma.blogPost.update({
    where: { id: existing.id },
    data: { status: 'SCHEDULED', scheduledAt, updatedById: await staffUserId(user) },
  });
  const fresh = await loadPost(publicId);
  await writeAdminAudit({
    ...actorOf(user),
    action: 'BLOG_SCHEDULED',
    entityType: 'BlogPost',
    entityId: fresh.publicId,
    meta: { slug: fresh.slug, scheduledAt: scheduledAt.toISOString() },
  });
  return toAdmin(fresh);
}

export async function setFeatured(user, publicId, featured) {
  const existing = await loadPost(publicId);
  const wantFeatured = Boolean(featured);
  if (wantFeatured && !existing.featured) await assertFeaturedSlotAvailable(existing.id);
  await prisma.blogPost.update({
    where: { id: existing.id },
    data: { featured: wantFeatured, updatedById: await staffUserId(user) },
  });
  const fresh = await loadPost(publicId);
  await writeAdminAudit({
    ...actorOf(user),
    action: wantFeatured ? 'BLOG_FEATURED' : 'BLOG_UNFEATURED',
    entityType: 'BlogPost',
    entityId: fresh.publicId,
    meta: { slug: fresh.slug },
  });
  return toAdmin(fresh);
}

export async function blogAnalytics() {
  const live = { deletedAt: null, status: 'PUBLISHED' };
  const [views, publishedViews, mostViewed, recent, grouped] = await Promise.all([
    prisma.blogPost.aggregate({ where: { deletedAt: null }, _sum: { viewCount: true } }),
    prisma.blogPost.aggregate({ where: live, _sum: { viewCount: true }, _count: { _all: true } }),
    prisma.blogPost.findMany({
      where: live,
      orderBy: { viewCount: 'desc' },
      take: 6,
      include: POST_INCLUDE,
    }),
    prisma.blogPost.findMany({
      where: live,
      orderBy: { publishedAt: 'desc' },
      take: 6,
      include: POST_INCLUDE,
    }),
    prisma.blogPost.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    }),
  ]);
  const statusCounts = { ALL: 0, DRAFT: 0, SCHEDULED: 0, PUBLISHED: 0 };
  for (const row of grouped) {
    statusCounts[row.status] = row._count._all;
    statusCounts.ALL += row._count._all;
  }
  const publishedCount = publishedViews._count._all || 0;
  const publishedViewSum = publishedViews._sum.viewCount || 0;
  return {
    totalViews: views._sum.viewCount || 0,
    statusCounts,
    avgViewsPerArticle: publishedCount ? Math.round(publishedViewSum / publishedCount) : 0,
    mostViewed: mostViewed.map(toCard),
    recentlyPublished: recent.map(toCard),
  };
}

function mapTaxonomy(row, kind) {
  return {
    id: row.publicId,
    name: row.name,
    slug: row.slug,
    description: row.description || '',
    imageUrl: kind === 'category' ? row.imageUrl || null : null,
    imageAlt: kind === 'category' ? row.imageAlt || null : null,
    seoTitle: row.seoTitle || null,
    metaDescription: row.metaDescription || null,
    postCount: row._count?.posts ?? row.postCount ?? 0,
    updatedAt: row.updatedAt,
  };
}

function taxonomyData(kind, body, slug) {
  const data = {
    name: cleanText(body.name, 80),
    slug,
    description: cleanText(body.description, 600) || '',
    seoTitle: cleanText(body.seoTitle, 70),
    metaDescription: cleanText(body.metaDescription, 180),
  };
  if (kind === 'category') {
    data.imageUrl = body.imageUrl === undefined ? undefined : cleanText(body.imageUrl, 500);
    data.imageAlt = body.imageAlt === undefined ? undefined : cleanText(body.imageAlt, 180);
  }
  return data;
}

async function upsertTaxonomy(kind, body, user, existing) {
  const name = cleanText(body.name, 80);
  if (!name) throw new AppError(400, 'Name is required');
  const model = kind === 'category' ? prisma.blogCategory : prisma.blogTag;
  const slug = await uniqueTaxonomySlug(model, body.slug || existing?.slug || name, existing?.id);
  const data = taxonomyData(kind, { ...body, name }, slug);
  const row = existing
    ? await model.update({ where: { id: existing.id }, data, include: { _count: { select: { posts: true } } } })
    : await model.create({ data, include: { _count: { select: { posts: true } } } });
  await writeAdminAudit({
    ...actorOf(user),
    action: existing ? `BLOG_${kind.toUpperCase()}_UPDATED` : `BLOG_${kind.toUpperCase()}_CREATED`,
    entityType: kind === 'category' ? 'BlogCategory' : 'BlogTag',
    entityId: row.publicId,
    meta: { slug: row.slug },
  });
  return mapTaxonomy(row, kind);
}

async function uniqueTaxonomySlug(model, base, ignoreId) {
  let slug = slugifyBlog(base);
  let n = 1;
  while (true) {
    const existing = await model.findFirst({
      where: { slug, ...(ignoreId ? { NOT: { id: ignoreId } } : {}) },
      select: { id: true },
    });
    if (!existing) return slug;
    n += 1;
    slug = `${slugifyBlog(base).slice(0, 70)}-${n}`;
  }
}

export async function listCategories() {
  const rows = await prisma.blogCategory.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { posts: true } } } });
  return rows.map((row) => mapTaxonomy(row, 'category'));
}

export async function createCategory(user, body) {
  return upsertTaxonomy('category', body, user);
}

export async function updateCategory(user, publicId, body) {
  const existing = await prisma.blogCategory.findUnique({ where: { publicId } });
  if (!existing) throw new AppError(404, 'Category not found');
  return upsertTaxonomy('category', body, user, existing);
}

export async function deleteCategory(user, publicId) {
  const existing = await prisma.blogCategory.findUnique({ where: { publicId } });
  if (!existing) throw new AppError(404, 'Category not found');
  await prisma.blogCategory.delete({ where: { id: existing.id } });
  await writeAdminAudit({
    ...actorOf(user),
    action: 'BLOG_CATEGORY_DELETED',
    entityType: 'BlogCategory',
    entityId: existing.publicId,
    meta: { slug: existing.slug },
  });
}

export async function listTags() {
  const rows = await prisma.blogTag.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { posts: true } } } });
  return rows.map((row) => mapTaxonomy(row, 'tag'));
}

export async function createTag(user, body) {
  return upsertTaxonomy('tag', body, user);
}

export async function updateTag(user, publicId, body) {
  const existing = await prisma.blogTag.findUnique({ where: { publicId } });
  if (!existing) throw new AppError(404, 'Tag not found');
  return upsertTaxonomy('tag', body, user, existing);
}

export async function deleteTag(user, publicId) {
  const existing = await prisma.blogTag.findUnique({ where: { publicId } });
  if (!existing) throw new AppError(404, 'Tag not found');
  await prisma.blogTag.delete({ where: { id: existing.id } });
  await writeAdminAudit({
    ...actorOf(user),
    action: 'BLOG_TAG_DELETED',
    entityType: 'BlogTag',
    entityId: existing.publicId,
    meta: { slug: existing.slug },
  });
}

export async function listPublicBlog({ search, category, tag, sort = 'latest', page = 1, limit = 12 }) {
  const now = new Date();
  const where = { ...publishedWhere(now) };
  if (search && String(search).trim()) {
    const q = String(search).trim();
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { excerpt: { contains: q, mode: 'insensitive' } },
      { authorName: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (category) where.categories = { some: { category: { slug: String(category) } } };
  if (tag) where.tags = { some: { tag: { slug: String(tag) } } };
  const unfiltered = !search && !category && !tag;
  const orderBy =
    sort === 'popular'
      ? [{ viewCount: 'desc' }, { publishedAt: 'desc' }]
      : [{ publishedAt: 'desc' }];
  const take = Math.min(24, Math.max(1, Number(limit) || 12));
  const currentPage = Math.max(1, Number(page) || 1);

  const featured = await prisma.blogPost.findMany({
    where: { ...publishedWhere(now), featured: true },
    include: POST_INCLUDE,
    orderBy: [{ updatedAt: 'desc' }, { publishedAt: 'desc' }],
    take: BLOG_FEATURED_LIMIT,
  });

  // Default /blog grid excludes hero featured so they are not duplicated under Latest.
  if (unfiltered && featured.length) {
    where.id = { notIn: featured.map((p) => p.id) };
  }

  const needsPopular = Boolean(category);
  const [rows, total, popular, publishedTotal, categories, tags] = await Promise.all([
    prisma.blogPost.findMany({ where, include: POST_INCLUDE, orderBy, skip: (currentPage - 1) * take, take }),
    prisma.blogPost.count({ where }),
    needsPopular
      ? prisma.blogPost.findMany({
          where: publishedWhere(now),
          include: POST_INCLUDE,
          orderBy: [{ viewCount: 'desc' }, { publishedAt: 'desc' }],
          take: 4,
        })
      : Promise.resolve([]),
    unfiltered
      ? prisma.blogPost.count({ where: publishedWhere(now) })
      : Promise.resolve(null),
    prisma.blogCategory.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { posts: true } } } }),
    prisma.blogTag.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { posts: true } } } }),
  ]);

  const articles = rows.map(toCard);
  return {
    featured: featured.map(toCard),
    articles,
    popular: popular.map(toCard),
    // Compat: clients that used `latest` for hero fallback can use articles.
    latest: articles.slice(0, 4),
    categories: categories.map((row) => mapTaxonomy(row, 'category')),
    tags: tags.map((row) => mapTaxonomy(row, 'tag')),
    pagination: {
      page: currentPage,
      limit: take,
      total,
      pages: Math.ceil(total / take) || 1,
      ...(publishedTotal != null ? { publishedTotal } : {}),
    },
  };
}

export async function getPublicTaxonomy(kind, slug, query = {}) {
  const model = kind === 'category' ? prisma.blogCategory : prisma.blogTag;
  const row = await model.findUnique({
    where: { slug: String(slug) },
    include: { _count: { select: { posts: true } } },
  });
  if (!row) throw new AppError(404, kind === 'category' ? 'Category not found' : 'Tag not found');
  const list = await listPublicBlog({
    ...query,
    category: kind === 'category' ? row.slug : undefined,
    tag: kind === 'tag' ? row.slug : undefined,
    search: undefined,
  });
  return { taxonomy: mapTaxonomy(row, kind), ...list };
}

export async function listPublicPaths() {
  const now = new Date();
  const [posts, categories, tags] = await Promise.all([
    prisma.blogPost.findMany({
      where: publishedWhere(now),
      select: { slug: true, updatedAt: true },
      orderBy: { publishedAt: 'desc' },
    }),
    prisma.blogCategory.findMany({
      where: { posts: { some: { post: publishedWhere(now) } } },
      select: { slug: true, updatedAt: true },
    }),
    prisma.blogTag.findMany({
      where: { posts: { some: { post: publishedWhere(now) } } },
      select: { slug: true, updatedAt: true },
    }),
  ]);
  return { posts, categories, tags };
}

export async function getPublicPost(slug) {
  const now = new Date();
  const post = await prisma.blogPost.findFirst({
    where: { ...publishedWhere(now), slug: String(slug) },
    include: POST_INCLUDE,
  });
  if (!post) throw new AppError(404, 'Article not found');
  const categoryIds = post.categories.map((c) => c.categoryId);
  const [related, previous, next] = await Promise.all([
    categoryIds.length
      ? prisma.blogPost.findMany({
          where: {
            ...publishedWhere(now),
            id: { not: post.id },
            categories: { some: { categoryId: { in: categoryIds } } },
          },
          include: POST_INCLUDE,
          orderBy: { publishedAt: 'desc' },
          take: 3,
        })
      : Promise.resolve([]),
    prisma.blogPost.findFirst({
      where: { ...publishedWhere(now), publishedAt: { lt: post.publishedAt } },
      include: POST_INCLUDE,
      orderBy: { publishedAt: 'desc' },
    }),
    prisma.blogPost.findFirst({
      where: { ...publishedWhere(now), publishedAt: { gt: post.publishedAt } },
      include: POST_INCLUDE,
      orderBy: { publishedAt: 'asc' },
    }),
  ]);
  return {
    article: {
      ...toCard(post),
      contentHtml: post.contentHtml,
      seoTitle: post.seoTitle,
      metaDescription: post.metaDescription,
      ogTitle: post.ogTitle,
      ogDescription: post.ogDescription,
      ogImageUrl: post.ogImageUrl,
      canonicalUrl: post.canonicalUrl,
    },
    related: related.map(toCard),
    previous: previous ? toCard(previous) : null,
    next: next ? toCard(next) : null,
  };
}

export async function recordPublicView(slug, cookieHeader, seenHeader) {
  const fromHeader = String(seenHeader || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = [...new Set([...parseSeenBlogSlugs(cookieHeader), ...fromHeader])];
  if (seen.includes(String(slug))) {
    return { counted: false, setCookie: null };
  }
  const now = new Date();
  const updated = await prisma.blogPost.updateMany({
    where: { ...publishedWhere(now), slug: String(slug) },
    data: { viewCount: { increment: 1 } },
  });
  if (updated.count === 0) throw new AppError(404, 'Article not found');
  return { counted: true, setCookie: seenBlogCookieValue([...seen, String(slug)]) };
}

export async function publishDueScheduledPosts() {
  const now = new Date();
  const due = await prisma.blogPost.findMany({
    where: { deletedAt: null, status: 'SCHEDULED', scheduledAt: { lte: now } },
    select: { id: true, publicId: true, slug: true, publishedAt: true },
  });
  for (const post of due) {
    await prisma.blogPost.update({
      where: { id: post.id },
      data: { status: 'PUBLISHED', publishedAt: post.publishedAt || now, scheduledAt: null },
    });
    await writeAdminAudit({
      actorId: null,
      actorEmail: 'system',
      action: 'BLOG_PUBLISHED',
      entityType: 'BlogPost',
      entityId: post.publicId,
      meta: { slug: post.slug, scheduled: true },
    });
  }
  return { published: due.length };
}
