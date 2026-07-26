# WhatsApp Reel FFmpeg Render Server

Server ini menerima request dari workflow n8n (`FFmpeg Render Video` node) dan
merender video reel produk (Mode 1/2/3) memakai FFmpeg.

## Struktur folder
```
server.js         -> logic utama (endpoint POST /render)
package.json
nixpacks.toml      -> supaya Railway install ffmpeg
music/             -> taruh 5 file musik di sini (nama harus cocok dengan
                       field "music" yang dikirim n8n, misal energetic-upbeat.mp3)
fonts/             -> taruh 3 font di sini:
                       - NotoSans-Regular.ttf (English)
                       - NotoSansDevanagari-Regular.ttf (Hindi)
                       - NotoSansGujarati-Regular.ttf (Gujarati)
output/            -> hasil render disimpan & di-serve sebagai file statis
```

## Environment variables yang wajib diisi di Railway
- `TWILIO_ACCOUNT_SID` — buat download media dari Twilio (butuh Basic Auth)
- `TWILIO_AUTH_TOKEN`
- `RAILWAY_PUBLIC_DOMAIN` — biasanya otomatis ke-set oleh Railway, tapi cek lagi
  di tab Settings > Networking kalau finalVideoUrl yang dikembalikan salah domain

## Cara deploy
1. Push folder ini ke repo GitHub baru
2. Di Railway: New Project > Deploy from GitHub Repo > pilih repo ini
3. Setelah deploy, buka tab **Settings > Networking** > klik **Generate Domain**
   supaya dapat URL publik (`https://xxxx.up.railway.app`)
4. Isi environment variables di atas (tab **Variables**)
5. Upload font & musik ke folder `fonts/` dan `music/` (lewat git push ulang,
   karena disk Railway ephemeral tiap deploy — file yang bukan di-commit ke git
   akan hilang saat redeploy)
6. Copy domain-nya, tempel ke node `Config` di n8n:
   `FFmpegEndpoint = https://xxxx.up.railway.app/render`

## Keterbatasan saat ini
- Mode 2 (slideshow 3-5 foto) untuk sementara masih render kayak Mode 1
  (1 foto) karena node n8n `Extract Twilio Fields` baru menangkap `MediaUrl0`
  saja. Supaya slideshow beneran jalan, n8n perlu ditambah field
  `MediaUrl1`, `MediaUrl2`, dst dan endpoint ini diupdate menerima array URL.
- Ukuran output di-fallback turunin CRF (23 -> 26 -> 28 -> 32) sampai <16MB;
  kalau di CRF 32 masih kegedean, file tetap dikirim balik (kualitas rendah)
  daripada gagal total — bisa disesuaikan lagi sesuai kebutuhan.
