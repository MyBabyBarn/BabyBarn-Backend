import { escapeHtml } from '../lib/escape.js';
import { renderEmailDocument } from './layout.js';
import {
  emailBodyParagraph,
  emailCtaButton,
  emailHeroText,
  emailInfoRows,
  emailInvoiceBlock,
  emailLinkFallback,
  emailMutedNote,
  emailOrderSummary,
  emailPanel,
  emailStatusBadge,
} from './components.js';

function doc(subject, preview, bodyHtml, brand) {
  return {
    subject,
    html: renderEmailDocument({ title: subject, preview, bodyHtml, brand }),
  };
}

function greet(name) {
  return emailBodyParagraph(`Hi ${escapeHtml(name || 'there')},`);
}

export function renderBrandedEmailTemplate(template, context = {}, brand) {
  const name = context.name || 'there';
  const actionUrl = context.actionUrl || context.loginUrl || '';

  if (template === 'verify-email') {
    const subject = 'Verify your Baby Barn account';
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph('Thanks for signing up. Please verify your email to activate your account and start shopping with member pricing.')}
      ${emailCtaButton(actionUrl, 'Verify email')}
      ${emailLinkFallback(actionUrl)}
    `;
    const { html } = doc(subject, 'Verify your email to activate your account.', bodyHtml, brand);
    return { subject, html, text: `Hi ${name}, verify your account: ${actionUrl}` };
  }

  if (template === 'forgot-password') {
    const subject = 'Reset your Baby Barn password';
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph('We received a request to reset your password. This link expires in <strong>60 minutes</strong>.')}
      ${emailCtaButton(actionUrl, 'Reset password')}
      ${emailMutedNote('If you did not request this, you can safely ignore this email.')}
      ${emailLinkFallback(actionUrl)}
    `;
    const { html } = doc(subject, 'Password reset instructions inside.', bodyHtml, brand);
    return { subject, html, text: `Reset your password (expires in 60 minutes): ${actionUrl}` };
  }

  if (template === 'welcome') {
    const subject = 'Welcome to Baby Barn';
    const bodyHtml = `
      ${emailHeroText('Welcome aboard', 'Your account is active — explore curated essentials for your little one.')}
      ${greet(name)}
      ${emailBodyParagraph('Shop new and circular pieces, track orders, and manage Farmhouse Friends from your dashboard.')}
      ${emailCtaButton(context.actionUrl, 'Go to dashboard')}
    `;
    const { html } = doc(subject, 'Welcome to Baby Barn', bodyHtml, brand);
    return { subject, html, text: `Welcome to Baby Barn. Open: ${context.actionUrl}` };
  }

  if (template === 'otp') {
    const subject = 'Your Baby Barn verification code';
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph('Your one-time verification code is:')}
      ${emailPanel(`<div style="text-align:center;font-size:32px;font-weight:800;letter-spacing:6px;color:#49297e;">${escapeHtml(context.otp || '')}</div>`)}
      ${emailMutedNote(`This code expires in ${escapeHtml(String(context.minutes || 10))} minutes.`)}
    `;
    const { html } = doc(subject, 'Your verification code', bodyHtml, brand);
    return { subject, html, text: `Your OTP is ${context.otp}. Expires in ${context.minutes || 10} minutes.` };
  }

  if (template === 'order-confirmation') {
    const subject = `Invoice ${context.orderId || ''} — Baby Barn order confirmed`.replace(/\s+/g, ' ').trim();
    const invoiceHtml = emailInvoiceBlock({
      invoiceNumber: context.orderId,
      issueDate: context.issueDate,
      paymentStatus: context.paymentStatus || 'Paid',
      orderStatus: context.orderStatus,
      billToLines: context.billToLines,
      shipToLines: context.shipToLines,
      lines: Array.isArray(context.lines) ? context.lines : [],
      subtotal: context.subtotal,
      shipping: context.shipping,
      tax: context.tax,
      storeCredit: context.storeCredit,
      accessMembership: context.accessMembership,
      total: context.total,
      paymentMethod: context.paymentMethod,
      shippingMethod: context.shippingMethod,
    });
    const bodyHtml = `
      ${emailHeroText('Order confirmed', 'Thank you — your invoice is below, and a PDF copy is attached for your records.')}
      ${greet(name)}
      ${emailBodyParagraph(
        `We've received payment for order <strong>${escapeHtml(context.orderId || '')}</strong> and are preparing your items with care.`
      )}
      ${invoiceHtml}
      ${
        context.invoiceAttached === false
          ? emailMutedNote('You can download your invoice anytime from your order details page.')
          : emailMutedNote('A printable invoice PDF is attached to this email for your records.')
      }
      ${emailCtaButton(context.actionUrl, context.trackingUrl ? 'View order details' : 'View your order')}
      ${context.trackingUrl && context.trackingUrl !== context.actionUrl ? emailCtaButton(context.trackingUrl, 'Track your order', 'secondary') : ''}
      ${context.returnUrl ? emailMutedNote(`Need to start a return? Use this secure link: ${context.returnUrl}`) : ''}
      ${context.includeReturnEnvelope ? emailMutedNote('As an ACCESS member, your package includes a reusable return envelope for eligible used product returns.') : ''}
      ${emailLinkFallback(context.actionUrl)}
    `;
    const { html } = doc(subject, `Invoice ${context.orderId || ''} — order confirmed`, bodyHtml, brand);
    const trackLine = context.trackingUrl ? ` Track: ${context.trackingUrl}` : '';
    const returnLine = context.returnUrl ? ` Start a return: ${context.returnUrl}` : '';
    const lineText = (Array.isArray(context.lines) ? context.lines : [])
      .map((li) => `- ${li.name} x${li.qty}: ${li.amount || li.total || ''}`)
      .join('\n');
    return {
      subject,
      html,
      text: [
        `Order ${context.orderId} confirmed. Total paid ${context.total}.`,
        lineText,
        `Subtotal ${context.subtotal || ''} · Shipping ${context.shipping || ''} · Total ${context.total || ''}`,
        `View: ${context.actionUrl}.${trackLine}${returnLine}`,
        'Invoice PDF attached.',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  if (template === 'order-tracking') {
    const subject = 'Your Baby Barn order has shipped';
    const bodyHtml = `
      ${emailHeroText('On the way', 'Your package is moving through our carbon-balanced route.')}
      ${greet(name)}
      ${emailPanel(
        `<table width="100%">${emailInfoRows([
          { label: 'Order', value: context.orderId, bold: true },
          { label: 'Carrier', value: context.carrier || 'UPS' },
          { label: 'Tracking', value: context.trackingNumber, bold: true },
        ])}</table>`,
        { title: 'Shipment' }
      )}
      ${emailCtaButton(context.actionUrl, 'Track your order')}
    `;
    const { html } = doc(subject, 'Tracking number inside', bodyHtml, brand);
    return {
      subject,
      html,
      text: `Order ${context.orderId} shipped. ${context.carrier} ${context.trackingNumber}. ${context.actionUrl}`,
    };
  }

  if (template === 'order-cancelled') {
    const subject = 'Your Baby Barn order was cancelled';
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph(`Your order <strong>${escapeHtml(context.orderId || '')}</strong> has been cancelled.`)}
      ${context.reason ? emailMutedNote(context.reason) : ''}
      ${emailCtaButton(context.actionUrl, 'View orders')}
    `;
    const { html } = doc(subject, 'Order cancellation notice', bodyHtml, brand);
    return { subject, html, text: `Order ${context.orderId} cancelled. ${context.actionUrl}` };
  }

  if (template === 'refund-confirmation') {
    const subject = 'Your Baby Barn refund is processing';
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph(`A refund of <strong>${escapeHtml(context.amount || '')}</strong> for order <strong>${escapeHtml(context.orderId || '')}</strong> has been initiated.`)}
      ${emailMutedNote('Depending on your bank, funds may take 5–10 business days to appear.')}
      ${emailCtaButton(context.actionUrl, 'View order')}
    `;
    const { html } = doc(subject, 'Refund confirmation', bodyHtml, brand);
    return { subject, html, text: `Refund ${context.amount} for order ${context.orderId}. ${context.actionUrl}` };
  }

  if (template === 'return-requested') {
    const subject = 'We received your return request';
    const returnRef = context.returnNumber ? String(context.returnNumber).trim() : '';
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph(`Your <strong>${escapeHtml(context.returnType || 'return')}</strong> request is in our queue. We will email you when inspection or shipping steps are ready.`)}
      ${returnRef ? emailBodyParagraph(`Return ID: <strong>${escapeHtml(returnRef)}</strong>`) : ''}
      ${emailMutedNote('Original shipping charges are not refundable on standard returns.')}
      ${emailCtaButton(context.actionUrl, 'Track return')}
    `;
    const { html } = doc(subject, 'Return request received', bodyHtml, brand);
    return {
      subject,
      html,
      text: `Return request received${returnRef ? ` (${returnRef})` : ''}. ${context.actionUrl}`,
    };
  }

  if (template === 'return-status') {
    const subject = 'Update on your return request';
    const statusRaw = String(context.status || '');
    const statusLabels = {
      REQUESTED: 'Requested',
      RECEIVED: 'Received at warehouse',
      UNDER_INSPECTION: 'Under inspection',
      APPROVED: context.returnType === 'REFURBISHMENT' || /used product/i.test(String(context.returnType || ''))
        ? 'Pre-Qualified'
        : 'Approved',
      REJECTED: 'Rejected',
      ELIGIBILITY_REVIEW: 'Eligibility review',
      ELIGIBILITY_REJECTED: 'Not eligible for used return',
      LABEL_GENERATED: 'Return label ready',
      IN_TRANSIT: 'In transit',
      INSPECTION_APPROVED: 'Passed inspection',
      INSPECTION_REJECTED: 'Cannot be reconditioned',
    };
    const statusLabel = statusLabels[statusRaw.toUpperCase()] || statusRaw.replace(/_/g, ' ');
    const tone =
      ['APPROVED', 'LABEL_GENERATED', 'INSPECTION_APPROVED'].includes(statusRaw.toUpperCase())
        ? 'success'
        : ['REJECTED', 'ELIGIBILITY_REJECTED', 'INSPECTION_REJECTED'].includes(statusRaw.toUpperCase())
          ? 'danger'
          : 'info';
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph('Your return request status has been updated:')}
      <p style="margin:12px 0 20px;">${emailStatusBadge(statusLabel, tone)}</p>
      ${context.note ? emailMutedNote(context.note) : ''}
      ${emailCtaButton(context.actionUrl, 'View return details')}
    `;
    const { html } = doc(subject, 'Return status update', bodyHtml, brand);
    return { subject, html, text: `Return status: ${statusLabel}. ${context.actionUrl}` };
  }

  if (template === 'return-package-request') {
    const statusKey = String(context.status || '').toUpperCase();
    const subject =
      statusKey === 'SENT'
        ? 'Your prepaid return package is on the way'
        : 'Your prepaid return package request was approved';
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph(
        statusKey === 'SENT'
          ? 'We dispatched a prepaid return package for your order.'
          : 'Your request for a replacement prepaid return package was approved.'
      )}
      ${context.trackingNumber ? emailMutedNote(`Tracking: ${escapeHtml(context.trackingNumber)}`) : ''}
      ${emailCtaButton(context.actionUrl, 'View orders')}
    `;
    const { html } = doc(subject, 'Return package update', bodyHtml, brand);
    return { subject, html, text: `Return package ${context.status}. ${context.actionUrl}` };
  }

  if (template === 'store-credit-update') {
    const subject = 'Store credit update — Baby Barn';
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph(`Your store credit balance was updated by <strong>${escapeHtml(context.amount || '')}</strong>.`)}
      ${context.note ? emailMutedNote(context.note) : ''}
      ${emailCtaButton(context.actionUrl, 'Open wallet')}
    `;
    const { html } = doc(subject, 'Store credit update', bodyHtml, brand);
    return { subject, html, text: `Store credit updated by ${context.amount}. ${context.actionUrl}` };
  }

  if (template === 'access-purchase') {
    const subject = 'Your Farmhouse Friends membership is active';
    const bodyHtml = `
      ${emailHeroText('Farmhouse Friends is active', 'Member pricing and circular returns are now unlocked.')}
      ${greet(name)}
      ${emailPanel(
        `<table width="100%">${emailInfoRows([
          { label: 'Member number', value: context.accessNumber, bold: true },
          { label: 'Amount paid', value: context.amount },
          { label: 'Valid through', value: context.validUntil, bold: true },
        ])}</table>`,
        { title: 'Membership' }
      )}
      ${emailCtaButton(context.actionUrl, 'View membership')}
    `;
    const { html } = doc(subject, 'Farmhouse Friends confirmed', bodyHtml, brand);
    return {
      subject,
      html,
      text: `Farmhouse Friends active. Member ${context.accessNumber}. Valid until ${context.validUntil}. ${context.actionUrl}`,
    };
  }

  if (template === 'access-renewal') {
    const subject = 'Your Farmhouse Friends membership has been renewed';
    const bodyHtml = `
      ${greet(name)}
      ${emailPanel(
        `<table width="100%">${emailInfoRows([
          { label: 'Member number', value: context.accessNumber },
          { label: 'Amount paid', value: context.amount },
          { label: 'New expiry', value: context.validUntil, bold: true },
        ])}</table>`,
        { title: 'Renewal' }
      )}
      ${emailCtaButton(context.actionUrl, 'View membership')}
    `;
    const { html } = doc(subject, 'Farmhouse Friends renewed', bodyHtml, brand);
    return { subject, html, text: `Farmhouse Friends renewed until ${context.validUntil}. ${context.actionUrl}` };
  }

  if (template === 'access-renewal-reminder') {
    const subject = 'Your Farmhouse Friends membership renews soon';
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph(
        `Your Farmhouse Friends membership (<strong>${escapeHtml(context.accessNumber || '')}</strong>) expires on <strong>${escapeHtml(context.validUntil || '')}</strong>.`
      )}
      ${emailBodyParagraph('Renew now to keep member pricing, returns, and refurbished access without interruption.')}
      ${emailCtaButton(context.actionUrl, 'Renew Farmhouse Friends', 'secondary')}
      ${emailMutedNote('Farmhouse Friends is an annual one-time payment — not a recurring subscription.')}
    `;
    const { html } = doc(subject, 'Renew Farmhouse Friends before it expires', bodyHtml, brand);
    return { subject, html, text: `Farmhouse Friends expires ${context.validUntil}. Renew: ${context.actionUrl}` };
  }

  if (template === 'access-expired') {
    const subject = 'Your Farmhouse Friends membership has expired';
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph(`Your Farmhouse Friends membership expired on <strong>${escapeHtml(context.validUntil || '')}</strong>.`)}
      ${emailBodyParagraph('Reactivate anytime to restore member pricing and circular benefits.')}
      ${emailCtaButton(context.actionUrl, 'Reactivate Farmhouse Friends')}
    `;
    const { html } = doc(subject, 'Farmhouse Friends expired', bodyHtml, brand);
    return { subject, html, text: `Farmhouse Friends expired. Reactivate: ${context.actionUrl}` };
  }

  if (template === 'team-invite') {
    const subject = 'Your Baby Barn team account';
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph(
        `Your team account was created with the role <strong>${escapeHtml(context.roleTitle || 'Team Member')}</strong>.`
      )}
      ${emailPanel(
        `<table width="100%">${emailInfoRows([
          { label: 'Email', value: context.email },
          { label: 'Temporary password', value: context.temporaryPassword, bold: true },
        ])}</table>`,
        { title: 'Sign-in credentials' }
      )}
      ${context.loginUrl ? emailCtaButton(context.loginUrl, 'Open admin console', 'secondary') : ''}
      ${context.loginUrl ? emailLinkFallback(context.loginUrl) : ''}
      ${emailMutedNote('Please change your password after your first login.')}
    `;
    const { html } = doc(subject, 'Team account credentials', bodyHtml, brand);
    return {
      subject,
      html,
      text: `Team account created. Email: ${context.email}. Temporary password: ${context.temporaryPassword}`,
    };
  }

  if (template === 'contact-inquiry-admin') {
    const subject = `[Baby Barn Contact] ${context.subjectLine || 'New message'}`;
    const bodyHtml = `
      ${emailHeroText('New contact inquiry', 'A customer submitted the storefront contact form.')}
      ${emailPanel(
        `<table width="100%">${emailInfoRows([
          { label: 'From', value: `${context.fromName || ''} <${context.fromEmail || ''}>` },
          { label: 'Subject', value: context.subjectLine, bold: true },
        ])}</table>`,
        { title: 'Sender' }
      )}
      ${emailPanel(`<pre style="white-space:pre-wrap;font-family:inherit;margin:0;font-size:14px;line-height:22px;color:#222;">${escapeHtml(context.message || '')}</pre>`, {
        title: 'Message',
      })}
    `;
    const { html } = doc(subject, context.subjectLine || 'Contact form', bodyHtml, brand);
    return { subject, html, text: context.plainText || '' };
  }

  if (template === 'back-in-stock') {
    const subject = `${context.productName || 'An item'} is back in stock`;
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph(
        `Good news — <strong>${escapeHtml(context.productName || 'your item')}</strong> is available again on Baby Barn.`
      )}
      ${context.actionUrl ? emailCtaButton(context.actionUrl, 'Shop now') : ''}
      ${context.actionUrl ? emailLinkFallback(context.actionUrl) : ''}
    `;
    const { html } = doc(subject, 'Back in stock', bodyHtml, brand);
    return { subject, html, text: `${context.productName} is back in stock.` };
  }

  if (template === 'price-drop') {
    const subject = `Price drop on ${context.productName || 'a wishlist item'}`;
    const bodyHtml = `
      ${greet(name)}
      ${emailBodyParagraph(
        `<strong>${escapeHtml(context.productName || 'An item')}</strong> on your wishlist is now <strong>${escapeHtml(context.newPrice || '')}</strong> (was ${escapeHtml(context.oldPrice || '')}).`
      )}
      ${context.actionUrl ? emailCtaButton(context.actionUrl, 'View product') : ''}
      ${context.actionUrl ? emailLinkFallback(context.actionUrl) : ''}
    `;
    const { html } = doc(subject, 'Wishlist price drop', bodyHtml, brand);
    return {
      subject,
      html,
      text: `${context.productName} dropped from ${context.oldPrice} to ${context.newPrice}.`,
    };
  }

  if (template === 'admin-return-request') {
    const subject = `[Admin] New ${context.returnType || 'return'} request`;
    const bodyHtml = `
      ${emailHeroText('New return request', 'A customer submitted a return that needs your attention.')}
      ${emailPanel(
        `<table width="100%">${emailInfoRows([
          { label: 'Type', value: context.returnType, bold: true },
          { label: 'Order', value: context.orderNumber },
          { label: 'Customer', value: context.customerEmail },
          { label: 'Reason', value: context.reason },
        ])}</table>`,
        { title: 'Return details' }
      )}
      ${context.actionUrl ? emailCtaButton(context.actionUrl, 'Open in admin') : ''}
      ${context.actionUrl ? emailLinkFallback(context.actionUrl) : ''}
    `;
    const { html } = doc(subject, 'New return request', bodyHtml, brand);
    return {
      subject,
      html,
      text: `New return: ${context.returnType} for ${context.orderNumber}. ${context.actionUrl || ''}`,
    };
  }

  if (template === 'admin-eligibility-review') {
    const subject = '[Admin] Refurb eligibility review needed';
    const bodyHtml = `
      ${emailHeroText('Eligibility review', 'A refurbishment return requires manual eligibility review.')}
      ${emailPanel(
        `<table width="100%">${emailInfoRows([
          { label: 'Order', value: context.orderNumber, bold: true },
          { label: 'Customer', value: context.customerEmail },
        ])}</table>`,
        { title: 'Return' }
      )}
      ${context.actionUrl ? emailCtaButton(context.actionUrl, 'Review eligibility') : ''}
      ${context.actionUrl ? emailLinkFallback(context.actionUrl) : ''}
    `;
    const { html } = doc(subject, 'Eligibility review needed', bodyHtml, brand);
    return {
      subject,
      html,
      text: `Eligibility review for ${context.orderNumber}. ${context.actionUrl || ''}`,
    };
  }

  if (template === 'admin-inspection-queued') {
    const subject = '[Admin] Return ready for inspection';
    const bodyHtml = `
      ${emailHeroText('Inspection queued', 'A refurbishment return is ready for the inspection workflow.')}
      ${emailPanel(
        `<table width="100%">${emailInfoRows([
          { label: 'Order', value: context.orderNumber, bold: true },
          { label: 'Customer', value: context.customerEmail },
        ])}</table>`,
        { title: 'Return' }
      )}
      ${context.actionUrl ? emailCtaButton(context.actionUrl, 'Open inspection') : ''}
      ${context.actionUrl ? emailLinkFallback(context.actionUrl) : ''}
    `;
    const { html } = doc(subject, 'Inspection queued', bodyHtml, brand);
    return {
      subject,
      html,
      text: `Inspection queued for ${context.orderNumber}. ${context.actionUrl || ''}`,
    };
  }

  if (template === 'admin-return-package-request') {
    const subject = '[Admin] Prepaid return package requested';
    const bodyHtml = `
      ${emailHeroText('Package request', 'A customer requested a prepaid return package.')}
      ${emailPanel(
        `<table width="100%">${emailInfoRows([
          { label: 'Order', value: context.orderNumber, bold: true },
          { label: 'Customer', value: context.customerEmail },
          { label: 'Reason', value: context.reason },
        ])}</table>`,
        { title: 'Request' }
      )}
      ${context.actionUrl ? emailCtaButton(context.actionUrl, 'Manage package requests') : ''}
      ${context.actionUrl ? emailLinkFallback(context.actionUrl) : ''}
    `;
    const { html } = doc(subject, 'Return package request', bodyHtml, brand);
    return {
      subject,
      html,
      text: `Package request for ${context.orderNumber}. ${context.actionUrl || ''}`,
    };
  }

  if (template === 'admin-new-order') {
    const subject = `[Admin] New paid order ${context.orderNumber || ''}`.trim();
    const lines = Array.isArray(context.lines) ? context.lines : [];
    const extraRows = [
      context.tax != null ? { label: 'Tax', value: context.tax } : null,
      context.storeCredit != null ? { label: 'Store credit', value: context.storeCredit } : null,
    ].filter(Boolean);
    const shipBlock = context.shippingAddress
      ? emailPanel(
          `<div style="font-size:13px;line-height:1.55;white-space:pre-line;">${escapeHtml(context.shippingAddress)}</div>`,
          { title: 'Shipping' }
        )
      : '';
    const bodyHtml = `
      ${emailHeroText('New paid order', 'Auto-accepted on payment — fulfill after the 60-minute cancel window.')}
      ${emailPanel(
        `<table width="100%">${emailInfoRows([
          { label: 'Order', value: context.orderNumber, bold: true },
          { label: 'Customer', value: context.customerName || context.customerEmail },
          { label: 'Email', value: context.customerEmail },
          { label: 'Phone', value: context.customerPhone },
          { label: 'Total', value: context.amount, bold: true },
        ].filter((r) => r.value))}</table>`,
        { title: 'Order' }
      )}
      ${lines.length
        ? emailOrderSummary({
            orderId: context.orderNumber,
            lines,
            subtotal: context.subtotal,
            shipping: context.shipping,
            total: context.amount,
            extraRows,
          })
        : ''}
      ${shipBlock}
      ${emailMutedNote('Invoice PDF is attached when available.')}
      ${context.actionUrl ? emailCtaButton(context.actionUrl, 'Open order') : ''}
      ${context.actionUrl ? emailLinkFallback(context.actionUrl) : ''}
    `;
    const { html } = doc(subject, 'New paid order', bodyHtml, brand);
    return {
      subject,
      html,
      text: `New order ${context.orderNumber}${context.amount ? ` (${context.amount})` : ''}. ${context.customerEmail || ''} ${context.actionUrl || ''}`,
    };
  }

  if (template === 'admin-low-stock') {
    const subject = `[Admin] Low stock: ${context.productName || 'Product'}`;
    const bodyHtml = `
      ${emailHeroText('Low stock alert', 'Inventory has dropped below the configured threshold.')}
      ${emailPanel(
        `<table width="100%">${emailInfoRows([
          { label: 'Product', value: context.productName, bold: true },
          { label: 'SKU', value: context.sku },
          { label: 'Available', value: String(context.available ?? ''), bold: true },
        ])}</table>`,
        { title: 'Inventory' }
      )}
      ${context.actionUrl ? emailCtaButton(context.actionUrl, 'Open inventory') : ''}
      ${context.actionUrl ? emailLinkFallback(context.actionUrl) : ''}
    `;
    const { html } = doc(subject, 'Low stock alert', bodyHtml, brand);
    return {
      subject,
      html,
      text: `Low stock: ${context.productName} (${context.available} available). ${context.actionUrl || ''}`,
    };
  }

  if (template === 'admin-cancellation-review') {
    const subject = `[Admin] Cancellation review for ${context.orderNumber || 'order'}`;
    const bodyHtml = `
      ${emailHeroText('Cancellation review', 'A customer requested order cancellation before shipment.')}
      ${emailPanel(
        `<table width="100%">${emailInfoRows([
          { label: 'Order', value: context.orderNumber, bold: true },
          { label: 'Customer', value: context.customerEmail },
        ])}</table>`,
        { title: 'Order' }
      )}
      ${context.actionUrl ? emailCtaButton(context.actionUrl, 'Review order') : ''}
      ${context.actionUrl ? emailLinkFallback(context.actionUrl) : ''}
    `;
    const { html } = doc(subject, 'Cancellation review needed', bodyHtml, brand);
    return {
      subject,
      html,
      text: `Cancellation review for ${context.orderNumber}. ${context.actionUrl || ''}`,
    };
  }

  throw new Error(`Unsupported email template: ${template}`);
}
