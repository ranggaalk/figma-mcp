# Figma MCP Bridge

MCP server supaya agent AI bisa membaca dan mendesain langsung di Figma, tanpa MCP resmi Figma, tanpa REST API, dan tanpa access token.

```
Agent ⇄ MCP (stdio) ⇄ dist/server.js ⇄ WebSocket localhost:3055 ⇄ plugin Figma ⇄ figma.* (Plugin API)
```

## Setup

1. Build:

   ```bash
   npm install
   npm run build
   ```

2. Pasang plugin di **Figma desktop**: buka file desain → `Plugins` → `Development` → `Import plugin from manifest…` → pilih `plugin/manifest.json`.

   Dari Windows, folder repo di WSL terlihat sebagai `\\wsl.localhost\<distro>\<path repo>\plugin\`, misalnya `\\wsl.localhost\Ubuntu-24.04\home\nama\Projects\figma-mcp\plugin\`. Kalau Figma tidak mau membaca path itu, salin `manifest.json`, `code.js`, dan `ui.html` ke folder Windows lalu import dari sana.

3. Daftarkan MCP server ke agent. Untuk Claude Code, `.mcp.json` di repo ini menunjuk ke `dist/server.js` dengan path absolut; sesuaikan path itu kalau repo ada di tempat lain. Supaya tersedia di semua project, jalankan dari folder repo:

   ```bash
   claude mcp add figma-bridge -s user -- node "$(pwd)/dist/server.js"
   ```

## Pemakaian

1. Jalankan agent (MCP server ikut menyala).
2. Di Figma: `Plugins` → `Development` → `Figma MCP Bridge`. Jendela plugin harus tetap terbuka; statusnya berubah jadi **Connected to MCP server**.
3. Minta agent mendesain, misalnya "buat layar login mobile di Figma memakai komponen dan warna file ini, lalu periksa hasilnya".

### Setelah update

Setelah menarik versi baru dan menjalankan `npm run build`:

1. Tutup jendela plugin di Figma, lalu jalankan lagi.
2. Kalau Anda mengimpor plugin dari folder Windows, salin ulang `manifest.json`, `code.js`, dan `ui.html` lebih dulu.
3. Restart sesi agent, atau sambungkan ulang MCP server (`/mcp` di Claude Code).

Kalau versi plugin dan server berbeda, setiap tool menampilkan peringatan.

## Tools

| Kelompok | Tool | Fungsi |
| --- | --- | --- |
| Membaca | `get_status` | Koneksi, file, halaman, selection, dan apakah jendela Figma terlihat |
| | `get_document_info` | Daftar halaman dan node tingkat atas di halaman aktif |
| | `get_selection` / `get_node` | Detail node yang dipilih, atau satu node berdasarkan id |
| | `find_nodes` | Cari layer berdasarkan nama, isi teks, atau tipe, di satu node, halaman ini, atau semua halaman |
| Design system | `get_styles` | Style lokal (warna, teks, efek) dan variable; opsional variable library tim dan style dari katalog |
| | `get_components` | Komponen dan component set beserta properti dan variant-nya, komponen library yang sudah dipakai, dan isi katalog library |
| | `save_library_catalog` | Simpan key komponen dan style file library ini, supaya bisa dipakai dari file lain |
| Mendesain | `build_design` | Buat frame beserta seluruh isinya dari satu spec JSON |
| | `update_nodes` | Ubah properti node yang sudah ada dengan format yang sama |
| | `place_image` | Masukkan file PNG/JPEG/GIF sebagai rectangle baru atau sebagai fill node |
| | `execute_code` | Jalankan kode Plugin API untuk hal yang tidak bisa diungkapkan lewat spec |
| Memeriksa | `check_design` | Temukan teks terpotong, konten terpotong, ukuran bawaan 100px, kontras rendah, warna di luar token, dan lainnya |
| | `export_node` | Render node ke PNG supaya agent bisa melihat hasilnya |
| Keamanan | `save_checkpoint` | Simpan versi bernama ke version history file |
| Pengetahuan | `get_skill` | Baca skill desain bawaan (lihat di bawah) |

`build_design`, `update_nodes`, `place_image`, dan `execute_code` menerima `screenshot: true` untuk langsung mengembalikan PNG hasilnya.

### Builder (`build_design` / `update_nodes`)

Satu spec menggambarkan satu pohon node:

```json
{"type":"frame","name":"Card","width":360,"padding":24,"gap":12,"fill":"#FFFFFF","radius":16,"children":[
  {"type":"text","text":"Upgrade to Pro","size":20,"weight":600},
  {"type":"text","text":"Unlimited projects.","width":"fill","color":"#475569","lineHeight":1.5},
  {"type":"line","fill":"#E2E8F0"}
]}
```

- **Tipe node:** `frame` (auto layout vertikal bawaan), `component`, `text`, `rect`, `ellipse`, `line` (garis pembatas), `svg` (ikon), dan `instance` (komponen).
- **Ukuran:** angka, `"fill"`, atau `"hug"`. Builder mengurus urutan yang diwajibkan Figma, misalnya `layoutMode` sebelum anak ditempel, `FIXED` sebelum resize, dan `FILL` sesudah node masuk ke parent.
- **Font:** dimuat otomatis, termasuk font lama saat teks diubah. Bobot boleh angka (`600`) atau nama style.
- **Validasi:** seluruh spec diperiksa sebelum ada node dibuat. Error menyebut lokasinya, misalnya `spec.children[2].fill: "blue-500" is not a color`, dan menyarankan nama properti yang benar (`backgroundColor` → `fill`).
- **Penempatan:** tanpa `parentId`, hasil ditaruh di ruang kosong di kanan konten yang ada; dengan `parentId` (dan opsional `index`), hasil disisipkan ke frame itu.
- **Layer bebas:** `absolute: true` dengan `x`, `y` mengeluarkan node dari alur auto layout. `constraints` (`left`/`right`/`center`/`stretch`/`scale` dan `top`/`bottom`/…) mengatur cara node mengikuti parent saat ukurannya berubah, misalnya `{ "horizontal": "stretch", "vertical": "bottom" }` untuk bar di tepi bawah.

`execute_code` tetap tersedia untuk hal yang butuh logika. Kodenya diturunkan ke ES2017 di server, jadi agent boleh memakai sintaks modern atau TypeScript. Di dalamnya, objek `h` menyediakan builder yang sama: `h.build`, `h.apply`, `h.setText`, `h.font`, `h.paint`, dan `h.color`. Tiga helper lain menutup jebakan Figma yang sering kena:

- `h.clone(node, { parent, index })`: menyalin node. Pakai ini, bukan `node.clone()`, saat salinan masuk ke frame dengan mode variable lain (misalnya dari layar Dark ke layar Light). Salinan biasa tetap membawa warna mode asalnya.
- `h.refreshVariables(node)`: meminta Figma menghitung ulang warna yang terikat variable pada node dan isinya. Ini perbaikan untuk temuan `stale-variable`.
- `h.annotate(node, "catatan **markdown**", "Development")`: menambah anotasi Dev Mode tanpa menghapus yang sudah ada.

### Design system

Spec bisa memakai token dan komponen file, alih-alih nilai mentah:

```json
{"type":"frame","fill":{"variable":"color/surface"},"gap":{"variable":"spacing/4"},"effectStyle":"Shadow/Card","children":[
  {"type":"text","text":"Pengaturan","textStyle":"Heading/H2"},
  {"type":"instance","component":"Button","variant":{"Size":"Large"},"props":{"Label":"Simpan"}}
]}
```

- **Variable:** `{ "variable": "nama" }` untuk warna (fill, stroke, warna teks) dan angka (gap, padding, radius, strokeWeight). Nama boleh `Koleksi/nama`, id, atau key library.
- **Style:** `{ "style": "nama" }` untuk paint style, `textStyle` untuk teks, `effectStyle` untuk bayangan.
- **Instance:** `type: "instance"` dengan `component` (nama, id, atau key), `variant`, `props` (properti teks/boolean/swap), dan `texts` (override layer teks berdasarkan nama). `update_nodes` bisa mengganti variant dan properti instance yang sudah ada.
- **Gambar:** `place_image` mengembalikan `imageHash` yang bisa dipakai lagi sebagai `fill: { "image": "<hash>" }`.
- **Pesan error:** kesalahan menyebut pilihan yang tersedia, misalnya opsi variant, daftar properti, atau nama variable yang mirip.

#### Library tim

Plugin API tidak bisa melihat isi library, tapi bisa mengimpor berdasarkan key.

- **Variable library:** langsung bisa dipakai lewat nama (izin `teamlibrary`).
- **Komponen dan style library:**
  1. Buka file library sekali, jalankan plugin di sana, lalu minta agent memanggil `save_library_catalog`.
  2. Katalog disimpan di `~/.figma-mcp-bridge/libraries/` (bisa diubah dengan `FIGMA_BRIDGE_DATA_DIR`).
  3. Di file lain, `get_components` dan `get_styles` menampilkan isinya beserta key, dan builder mengimpornya saat dipakai.

  Hanya item yang sudah dipublish yang bisa diimpor.
- **Komponen library yang sudah dipakai di file** langsung terdeteksi dari instance-nya.

### Skill bawaan

Server membawa pengetahuan desain dalam bentuk skill (`skills/<nama>/SKILL.md`), ditulis khusus untuk tool di bridge ini:

| Skill | Isi |
| --- | --- |
| `design-direction` | Merancang layar: pahami tugasnya, baca design system file, rencanakan, bangun dengan `build_design`, lalu tinjau. Termasuk daftar kebiasaan yang membuat desain terlihat generik |
| `design-system` | Menyusun variable (primitives → semantic dengan mode Light/Dark, spacing, radius), text/effect style, dan komponen dengan variant dan properti, beserta resep `execute_code` |
| `accessibility` | WCAG 2.2 AA saat mendesain: kontras, ukuran teks dan target, state fokus/error, warna bukan satu-satunya penanda, catatan handoff, dan cara audit tanpa mengedit |
| `ux-writing` | Teks antarmuka: tombol, label, error, empty state, konfirmasi, format angka/tanggal Indonesia dan Inggris, dan pola yang terdengar seperti tulisan mesin |

Skill tersedia lewat tiga jalur:

- **Tool `get_skill`:** agent membacanya sendiri sebelum mulai. Instruksi server mengarahkan agent ke skill yang sesuai.
- **Resource MCP:** `skill://figma-bridge/<nama>`, bisa dilampirkan manual.
- **Prompt MCP:** perintah siap pakai yang menyertakan skill terkait.

| Prompt | Fungsi |
| --- | --- |
| `design_screen` | Rancang layar dari brief (argumen `brief`, opsional `platform`) |
| `audit_design` | Tinjau frame tanpa mengedit: aksesibilitas, copy, konsistensi token |
| `setup_design_system` | Buat atau perluas variable, style, dan komponen |
| `review_copy` | Usulkan perbaikan teks; diterapkan setelah disetujui |

Di Claude Code, prompt muncul sebagai perintah `/mcp__figma-bridge__design_screen` dan seterusnya. Di Claude Desktop, prompt ada di menu lampiran (+) bagian figma-bridge.

Teks skill ditulis untuk project ini. Sumber ide dan lisensinya tercantum di `skills/NOTICE.md`.

### Pemeriksaan desain

`check_design` memeriksa sebuah frame beserta isinya. Setiap temuan menyebut id node, jalur layer, dan saran perbaikan.

| Tingkat | Aturan |
| --- | --- |
| error | teks tidak muat di kotaknya; font tidak terpasang |
| warning | konten terpotong oleh frame yang meng-clip; anak keluar dari parent auto layout; layer berada sepenuhnya di luar frame-nya; frame auto layout masih 100px bawaan; kontras teks di bawah WCAG AA; warna sama dengan token tapi tidak terhubung; salinan yang masih menampilkan warna mode variable lain (`stale-variable`) |
| info | warna di luar palet file; teks tanpa text style; nama layer bawaan ("Frame 12") |

`build_design` dan `update_nodes` otomatis menjalankan pemeriksaan ini dan melaporkan error dan warning di field `check`, jadi agent bisa langsung memperbaikinya. Isi instance diperiksa di komponen utamanya. Aturan `stale-variable` hanya jalan di `check_design`, karena Figma baru menyimpan warna hasil variable sesaat setelah sebuah panggilan selesai.

Catatan teknis untuk `stale-variable`: di Figma, node hasil `clone()` yang langsung dipindah ke frame bermode lain tetap menyimpan warna mode asalnya, baik di `fills` maupun di layar, walau ikatan variable-nya utuh. Memasang ulang paint yang sama tidak membantu. Menyetel mode eksplisit lalu mengembalikannya membuat Figma menghitung ulang seluruh isi node; itulah yang dilakukan `h.refreshVariables`.

### Keamanan

- Setiap panggilan yang mengubah dokumen menjadi **satu langkah undo** (Ctrl+Z di Figma). Panggilan yang tidak mengubah apa pun tidak menambah langkah.
- Kalau panggilan gagal atau melewati batas waktu, **semua perubahannya dibatalkan otomatis**. Langkah sebelumnya, termasuk editan manual Anda, tidak ikut terbatalkan.
- Perubahan dijalankan satu per satu, jadi dua panggilan tidak saling menyela.
- Kode yang memanggil `figma.commitUndo()`, `figma.triggerUndo()`, atau `figma.closePlugin()` ditolak sebelum dijalankan.
- Agent diminta memanggil `save_checkpoint` sebelum mengubah desain yang sudah ada.

Catatan teknis: di Figma, `triggerUndo()` membatalkan perubahan yang belum di-commit **ditambah** satu langkah ter-commit sebelumnya, bahkan saat tidak ada perubahan baru. Karena itu rollback memasang satu perubahan penanda, meng-commit, baru membatalkan (lihat `plugin/src/mutation.ts`).

## Masalah umum

- **Plugin terus "Waiting for MCP server…"**: agent belum berjalan, atau Windows tidak bisa menjangkau `localhost:3055` di WSL. Untuk kasus kedua, aktifkan `networkingMode=mirrored` di `%UserProfile%\.wslconfig` lalu `wsl --shutdown`.
- **`export_node` atau `screenshot` gagal karena jendela tersembunyi**: Figma berhenti me-render saat jendelanya diminimize atau tertutup penuh oleh jendela lain. Taruh Figma berdampingan dengan terminal. Tool lain tetap jalan di latar belakang, kecuali pindah halaman (`figma.setCurrentPageAsync`), yang menunggu sampai jendela terlihat lagi.
- **"the Figma plugin is version X but this MCP server is Y"**: ikuti langkah [Setelah update](#setelah-update).
- **Error izin `teamlibrary`**: plugin masih memakai manifest lama. Salin ulang `manifest.json` (atau import ulang manifest), lalu jalankan ulang plugin.
- **"Port 3055 is already in use"**: ada sesi agent lain yang menjalankan server ini. Tutup salah satunya.
- **Ganti port**: ubah di tiga tempat, yaitu env `FIGMA_BRIDGE_PORT`, `WS_URL` di `plugin/ui.html`, dan `devAllowedDomains` di `plugin/manifest.json`.

## Pengembangan

```bash
npm test   # build, lalu tes end-to-end
```

Tes menjalankan MCP client sungguhan → `dist/server.js` → WebSocket → `plugin/code.js`, dengan API Figma tiruan di `test/mock-figma.mjs`. Mock itu meniru aturan Figma yang sering bikin error: font harus dimuat, `FILL`/`HUG` hanya di tempat yang valid, dynamic page loading, dan semantik undo yang diamati di Figma asli.

| Bagian | Lokasi |
| --- | --- |
| Server MCP dan tool | `src/server.ts` |
| Jembatan WebSocket | `src/bridge.ts` |
| Protokol bersama dan versi | `src/protocol.ts` |
| Skema spec untuk agent | `src/spec-schema.ts` |
| Katalog library | `src/catalog.ts` |
| Plugin: loop pesan | `plugin/src/code.ts` |
| Plugin: builder | `plugin/src/builder.ts` |
| Plugin: pencarian variable/style/komponen | `plugin/src/library.ts` |
| Plugin: pemeriksaan | `plugin/src/checks.ts` |
| Plugin: undo dan rollback | `plugin/src/mutation.ts` |
| Skill bawaan (dimuat oleh `src/skills.ts`) | `skills/` |

## Batasan

- Figma harus terbuka dan plugin harus berjalan; tidak bisa headless.
- Hanya file yang sedang dibuka. Kalau plugin berjalan di beberapa file, perintah dikirim ke yang terakhir terhubung.
- Satu sesi agent pada satu waktu (satu port).
- Komentar, membaca version history, dan daftar file/project tidak tersedia (itu hanya ada di REST API).
