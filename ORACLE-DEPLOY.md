# Deploying Echo free on an Oracle Cloud "Always Free" VM

This gets you a **free, always-on** server (independent of your PC and home
network), with a fixed address. Oracle's Always Free **Ampere A1 (ARM)** tier
gives up to 4 CPUs / 24 GB RAM at no cost — plenty for Whisper.

> Heads-up: Oracle requires a credit card to verify your identity (you are
> **not** charged on Always Free). Ampere capacity is occasionally "out of
> stock" in a region — if so, try a different Availability Domain or region, or
> retry later.

The whole on-server install is a **single script** (`oracle-setup.sh`).

---

## Step 1 — Put the code on GitHub (so the VM can fetch it)

From `C:\Users\cleme\transcribe-app` in a fresh PowerShell window:

```powershell
gh auth login          # one-time, browser
gh repo create echo-transcribe --public --source . --push
```

> Public is fine — the repo contains **no secrets** (your API key/password live
> only in gitignored files). Prefer private? Use `--private`, but then you'll
> also `gh auth login` on the VM, or clone with a token.

Copy the repo's HTTPS URL, e.g. `https://github.com/<you>/echo-transcribe.git`.

## Step 2 — Create the Always Free VM

1. Sign up at https://www.oracle.com/cloud/free/ and log into the Console.
2. **Menu → Compute → Instances → Create Instance.**
3. Name it `echo`. Under **Image and shape**:
   - Image: **Canonical Ubuntu 22.04** (or 24.04).
   - Shape: **Change shape → Ampere → VM.Standard.A1.Flex**. Set **2 OCPUs /
     12 GB** (still free). Confirm it says "Always Free eligible".
4. Under **Add SSH keys**: choose **Generate a key pair for me** and **download
   the private key** (you'll need it to connect). Or paste your own public key.
5. Click **Create**. When it's running, copy the **Public IP address**.

## Step 3 — Open ports 80 and 443 (cloud firewall)

1. On the instance page, click its **Subnet**, then the **Default Security
   List**.
2. **Add Ingress Rules** → for each of port **80** and **443**:
   - Source CIDR: `0.0.0.0/0`
   - IP Protocol: **TCP**, Destination Port: `80` (then again `443`)
3. Save. (The setup script opens the VM's own internal firewall for you.)

## Step 4 — Connect via SSH

From PowerShell (use the key you downloaded):

```powershell
ssh -i C:\path\to\your-key.key ubuntu@<YOUR_VM_PUBLIC_IP>
```

(If it complains about key permissions, move the key somewhere simple like
`C:\Users\cleme\oracle.key`.)

## Step 5 — Run the one-command setup

On the VM. Pick **one** of the HTTPS options:

**Option A — HTTPS with a free hostname (recommended).** Use `sslip.io`, which
turns your IP into a hostname automatically (no account). Replace the dots in
your IP with dashes — e.g. IP `140.238.1.2` → `140-238-1-2.sslip.io`:

```bash
curl -fsSL https://raw.githubusercontent.com/<you>/echo-transcribe/main/oracle-setup.sh -o oracle-setup.sh
chmod +x oracle-setup.sh
REPO_URL="https://github.com/<you>/echo-transcribe.git" DOMAIN="140-238-1-2.sslip.io" ./oracle-setup.sh
```

**Option B — plain HTTP (no domain).** Skip `DOMAIN`; you'll reach it at
`http://<your-IP>` (password still required, but not encrypted in transit):

```bash
REPO_URL="https://github.com/<you>/echo-transcribe.git" ./oracle-setup.sh
```

The script installs Node, Python + faster-whisper, builds the app, runs it as a
service that restarts automatically, and sets up the web front-end. It prints a
generated login at the end.

## Step 6 — Add your API key and go live

```bash
nano /opt/echo/app/app.env      # set ANTHROPIC_API_KEY=... and APP_PASSWORD=...
sudo systemctl restart echo
```

Open your site:
- Option A: `https://140-238-1-2.sslip.io`
- Option B: `http://<your-IP>`

Done — it now runs 24/7 with a fixed address, no PC required. 🎉

---

## Everyday commands

```bash
journalctl -u echo -f                 # app logs
sudo systemctl restart echo           # restart after editing app.env
cd /opt/echo/app && git pull && npm ci && npm run build && sudo systemctl restart echo   # update
```

## Notes
- First transcription downloads the Whisper model (~140 MB) to `/opt/echo/data/hf`.
- Bigger model = more accuracy: set `WHISPER_MODEL=small` in `app.env`.
- If `pip install faster-whisper` fails to find an ARM wheel, the script's
  `build-essential` lets it compile — slower, but it works.
