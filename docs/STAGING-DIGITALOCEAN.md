# MyBABY BARN — Staging on DigitalOcean (separate from production)

Test on **staging first** (`stg` branch → DigitalOcean), then promote to production (`master` → AWS EC2).

| | **Staging** | **Production** |
|--|--|--|
| Cloud | DigitalOcean project `MyBabyBarn-Staging` | AWS EC2 `13.218.44.12` |
| Git branch | `stg` | `master` |
| Repos | Same three: Backend / Frontend / Admin | Same |
| Droplet paths | `/var/www/BabyBarn-Backend`, `BabyBarn-Frontend`, `BabyBarn-Admin` | Same path names on EC2 |
| PM2 | `babybarn-stg-api`, `babybarn-stg-store`, `babybarn-stg-admin` | `babybarn-api`, `babybarn-store`, `babybarn-admin` |
| Database | Separate Postgres (`babybarn_stg`) | Live `ecommerce` |
| Domains | `stg.` / `admin.stg.` / `api.stg.mybabybarn.com` | production hosts |
| Stripe / email | **Test** keys | Live keys |

Never reuse production `DATABASE_URL`, JWT secrets, or Stripe live keys on staging.

---

## Create DigitalOcean project (one-time)

1. DO → **Projects** → **New Project** → name `MyBabyBarn-Staging`
2. **Create Droplet**: Ubuntu 24.04, ≥2 GB RAM (4 GB better), SSH key, hostname `babybarn-stg`, assign to that project
3. Optional: **Managed PostgreSQL** in the same project; trusted source = staging droplet only; DB name `babybarn_stg`
4. DNS A records → droplet IP: `stg`, `admin.stg`, `api.stg.mybabybarn.com`
5. Firewall: 22, 80, 443

---

## Bootstrap + first deploy

```bash
ssh root@YOUR_STG_IP
# clone backend first so scripts exist, or paste bootstrap from repo
git clone -b stg https://github.com/MyBabyBarn/BabyBarn-Backend.git /var/www/BabyBarn-Backend
bash /var/www/BabyBarn-Backend/deploy/stg/server-bootstrap-stg.sh

cp /var/www/BabyBarn-Backend/.env.stg.example /var/www/BabyBarn-Backend/.env
cp /var/www/BabyBarn-Admin/.env.stg.example /var/www/BabyBarn-Admin/.env
cp /var/www/BabyBarn-Frontend/.env.stg.example /var/www/BabyBarn-Frontend/.env
# edit staging secrets only

bash /var/www/BabyBarn-Backend/deploy/stg/deploy-all-stg.sh
pm2 save && pm2 startup

sudo cp /var/www/BabyBarn-Backend/deploy/stg/nginx-stg.conf /etc/nginx/sites-available/babybarn-stg
sudo ln -sf /etc/nginx/sites-available/babybarn-stg /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d stg.mybabybarn.com -d admin.stg.mybabybarn.com -d api.stg.mybabybarn.com
```

---

## GitHub Actions (push to `stg`)

Add **staging-only** secrets on each repo (or at least Backend): `STG_HOST`, `STG_USER`, `STG_SSH_PRIVATE_KEY`.  
Workflow: `.github/workflows/deploy-stg.yml` (Backend). Production `EC2_*` secrets stay for `master`.

---

## Promote to production

1. QA on `stg.*`
2. Merge `stg` → `master` on Backend, Admin, Frontend
3. Deploy production via existing EC2 workflows / `docs/DEPLOY-EC2.md`
4. Do not copy staging `.env` to production
