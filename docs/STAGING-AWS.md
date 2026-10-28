# MyBABY BARN — Staging on AWS (separate from production)

**Goal:** Test carousel, inventory, and all new work on **`stg` first**, then promote to production (`master` → live EC2).

| | **Staging (this doc)** | **Production (unchanged)** |
|--|--|--|
| AWS | New stack `MyBabyBarn-Staging` (own VPC / EC2 / optional RDS) | Existing EC2 `13.218.44.12` |
| Git branch | `stg` | `master` |
| Paths on host | `/var/www/BabyBarn-Backend` · `Frontend` · `Admin` | Same path names — **different machine** |
| PM2 names | `babybarn-stg-api` · `babybarn-stg-store` · `babybarn-stg-admin` | `babybarn-api` · `babybarn-store` · `babybarn-admin` |
| Database | **Separate** RDS `babybarn_stg` (or Postgres only on stg EC2) | Live `ecommerce` on prod |
| Domains | `stg.mybabybarn.com` · `admin.stg…` · `api.stg…` | `mybabybarn.com` · `admin…` · `api…` |
| Stripe / email | **Test** keys | Live keys |
| GitHub secrets | `STG_*` | `EC2_*` |

Never point staging `.env` at production `DATABASE_URL`, Stripe live keys, or production JWT secrets.

---

## Flow

```text
Local work → commit → push origin stg
        → GitHub Action deploy-stg (or manual SSH)
        → QA on stg.*
        → merge stg → master (PR)
        → production deploy (existing EC2_* workflows)
```

---

## 1. Create the AWS staging “project” (one-time)

### Option A — CloudFormation (recommended)

From a machine with AWS CLI configured:

```bash
cd backend   # BabyBarn-Backend repo

aws cloudformation deploy \
  --stack-name MyBabyBarn-Staging \
  --template-file deploy/stg/aws/stg-ec2.yaml \
  --parameter-overrides \
    KeyName=YOUR_STAGING_KEY_PAIR \
    AllowedSshCidr=YOUR.PUBLIC.IP/32 \
    CreateDatabase=true \
    DbPassword='PickALongUniqueStgPassword' \
  --capabilities CAPABILITY_NAMED_IAM \
  --tags Project=MyBabyBarn Env=staging
```

Then:

```bash
aws cloudformation describe-stacks \
  --stack-name MyBabyBarn-Staging \
  --query "Stacks[0].Outputs" --output table
```

Note **StagingPublicIp** and **StagingDbEndpoint**.

### Option B — AWS Console (manual)

1. AWS Console → search **EC2** → **Launch instance**
   - Name: `mybabybarn-stg`
   - AMI: **Ubuntu Server 24.04 LTS**
   - Type: **t3.medium** (or larger)
   - Key pair: create/select a **staging** key (not the prod key if you can avoid it)
   - Network: new VPC or a VPC that is **not** production’s app VPC (isolation)
   - Security group: SSH (your IP), HTTP 80, HTTPS 443
   - Storage: 40 GB gp3
   - Tags: `Project=MyBabyBarn`, `Env=staging`
2. Allocate an **Elastic IP** → associate with the instance
3. (Recommended) **RDS** → PostgreSQL 16, db.t4g.micro, DB name `babybarn_stg`, **not publicly accessible**, SG only allows 5432 from the staging EC2 SG
4. Optional: create an AWS **Resource Group** / Console “application” named `MyBabyBarn-Staging` tagging these resources

Rough monthly cost (us-east-1, always-on): EC2 t3.medium ~$30 + EIP + 40GB disk; RDS db.t4g.micro ~$15–25. Stop the EC2 when idle to save.

---

## 2. DNS

Point A records to the staging Elastic IP:

- `stg.mybabybarn.com`
- `admin.stg.mybabybarn.com`
- `api.stg.mybabybarn.com`

Do **not** change production DNS.

---

## 3. Bootstrap the staging EC2

```bash
ssh -i your-stg-key.pem ubuntu@STAGING_PUBLIC_IP

# One-time (clones all three repos on branch stg):
curl -fsSL https://raw.githubusercontent.com/MyBabyBarn/BabyBarn-Backend/stg/deploy/stg/server-bootstrap-stg.sh | sudo bash
# or after first clone:
sudo bash /var/www/BabyBarn-Backend/deploy/stg/server-bootstrap-stg.sh
```

Creates / updates:

```text
/var/www/BabyBarn-Backend   (branch stg)
/var/www/BabyBarn-Frontend  (branch stg)
/var/www/BabyBarn-Admin     (branch stg)
```

---

## 4. Staging env files (server only — never commit)

```bash
sudo -u ubuntu -i
cp /var/www/BabyBarn-Backend/.env.stg.example  /var/www/BabyBarn-Backend/.env
cp /var/www/BabyBarn-Admin/.env.stg.example    /var/www/BabyBarn-Admin/.env
cp /var/www/BabyBarn-Frontend/.env.stg.example /var/www/BabyBarn-Frontend/.env
nano /var/www/BabyBarn-Backend/.env   # STG DATABASE_URL, JWT_*, Stripe TEST, CORS
nano /var/www/BabyBarn-Admin/.env
nano /var/www/BabyBarn-Frontend/.env
```

`DATABASE_URL` must be the **staging** RDS (or local Postgres on this host), never production.

---

## 5. First deploy

```bash
bash /var/www/BabyBarn-Backend/deploy/stg/deploy-all-stg.sh
pm2 save
pm2 startup
```

Health:

```bash
curl -s http://127.0.0.1:5000/health/live
curl -sI http://127.0.0.1:3000
curl -sI http://127.0.0.1:3001
```

---

## 6. Nginx + TLS

```bash
sudo cp /var/www/BabyBarn-Backend/deploy/stg/nginx-stg.conf /etc/nginx/sites-available/babybarn-stg
sudo ln -sf /etc/nginx/sites-available/babybarn-stg /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d stg.mybabybarn.com -d admin.stg.mybabybarn.com -d api.stg.mybabybarn.com
```

---

## 7. GitHub Actions (push `stg` → staging EC2)

In **each** of Backend / Admin / Frontend → Settings → Secrets → Actions  
Add **staging-only** secrets (different from production `EC2_*`):

| Secret | Value |
|--------|--------|
| `STG_HOST` | Staging Elastic IP |
| `STG_USER` | `ubuntu` |
| `STG_SSH_PRIVATE_KEY` | Staging private key PEM |
| `STG_SSH_PORT` | `22` (optional) |
| `STG_BASE` | `/var/www` (optional) |

Workflows:

- Backend: `.github/workflows/deploy-stg.yml` (runs `deploy-all-stg.sh`)
- Admin / Frontend: `.github/workflows/deploy-stg.yml` (deploy that app only)

Triggers on push to **`stg` only**. Production `master` → `EC2_*` stays unchanged.

---

## 8. Promote staging → production

1. QA on `stg.*` (carousel, inventory, Stripe **test** checkout).
2. Open PR: `stg` → `master` in each repo (or monorepo PR if applicable).
3. Merge → production Actions deploy with existing `EC2_*` secrets.
4. Do **not** copy staging `.env` to production.

---

## Isolation checklist

- [ ] CloudFormation / Console resources tagged `Env=staging`
- [ ] Separate EC2 (not `13.218.44.12`)
- [ ] Separate Postgres / credentials
- [ ] Separate JWT secrets
- [ ] Stripe **test** mode
- [ ] Staging hostnames only in CORS / `NEXT_PUBLIC_*`
- [ ] PM2 process names use `babybarn-stg-*`
- [ ] GitHub secrets use `STG_*` (never overwrite `EC2_*`)
