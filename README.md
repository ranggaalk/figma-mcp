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

   Dari Windows, folder WSL ini ada di `\\wsl.localhost\Ubuntu-24.04\home\ranggaalk\Projects\figma-mcp\plugin\`. Kalau Figma tidak mau membaca path itu, salin `manifest.json`, `code.js`, dan `ui.html` ke folder Windows lalu import dari sana.

3. Daftarkan MCP server ke agent. Untuk Claude Code di folder ini sudah ada `.mcp.json`. Supaya tersedia di semua project:

   ```bash
   claude mcp add figma-bridge -s user -- node /home/ranggaalk/Projects/figma-mcp/dist/server.js
   ```

## Pemakaian

1. Jalankan agent (MCP server ikut menyala).
2. Di Figma: `Plugins` → `Development` → `Figma MCP Bridge`. Jendela plugin harus tetap terbuka; statusnya berubah jadi **Connected to MCP server**.
3. Minta agent mendesain, misalnya: "buat frame login mobile di Figma, lalu cek hasilnya".

## Tools

| Tool | Fungsi |
| --- | --- |
| `get_status` | Cek koneksi, file, halaman, dan selection aktif |
| `get_document_info` | Daftar halaman dan node tingkat atas di halaman aktif |
| `get_selection` | Detail node yang sedang dipilih |
| `get_node` | Detail satu node berdasarkan id |
| `get_styles` | Style lokal (warna, teks, efek) dan variable |
| `export_node` | Render node ke PNG supaya agent bisa melihat hasilnya |
| `execute_code` | Menjalankan kode Plugin API untuk membuat dan mengubah desain |
| `save_checkpoint` | Menyimpan versi bernama ke version history file |

Kode untuk `execute_code` diturunkan ke ES2017 di server sebelum dikirim, jadi agent boleh memakai sintaks modern atau TypeScript.

### Keamanan

- Setiap panggilan yang mengubah dokumen menjadi **satu langkah undo** (Ctrl+Z di Figma). Panggilan yang tidak mengubah apa pun tidak menambah langkah.
- Kalau panggilan gagal atau melewati batas waktu, **semua perubahannya dibatalkan otomatis**. Langkah sebelumnya, termasuk editan manual Anda, tidak ikut terbatalkan.
- Perubahan dijalankan satu per satu, jadi dua panggilan tidak saling menyela.
- Kode yang memanggil `figma.commitUndo()`, `figma.triggerUndo()`, atau `figma.closePlugin()` ditolak sebelum dijalankan.
- Agent diminta memanggil `save_checkpoint` sebelum mengubah desain yang sudah ada.

Catatan teknis: di Figma, `triggerUndo()` membatalkan perubahan yang belum di-commit **ditambah** satu langkah ter-commit sebelumnya, bahkan saat tidak ada perubahan baru. Karena itu rollback memasang satu perubahan penanda, meng-commit, baru membatalkan (lihat `plugin/src/mutation.ts`).

## Masalah umum

- **Plugin terus "Waiting for MCP server…"**: agent belum berjalan, atau Windows tidak bisa menjangkau `localhost:3055` di WSL. Untuk kasus kedua, aktifkan `networkingMode=mirrored` di `%UserProfile%\.wslconfig` lalu `wsl --shutdown`.
- **`export_node` gagal dengan "Figma did not finish rendering"**: jendela Figma sedang diminimize atau tertutup penuh oleh jendela lain, dan Figma berhenti me-render di latar belakang. Taruh Figma berdampingan dengan terminal. Tool lain tetap jalan di latar belakang, hanya lebih lambat.
- **"Port 3055 is already in use"**: ada sesi agent lain yang menjalankan server ini. Tutup salah satunya.
- **Ganti port**: ubah di tiga tempat, yaitu env `FIGMA_BRIDGE_PORT`, `WS_URL` di `plugin/ui.html`, dan `devAllowedDomains` di `plugin/manifest.json`.

## Pengembangan

```bash
npm test   # build, lalu tes end-to-end
```

Tes menjalankan MCP client sungguhan → `dist/server.js` → WebSocket → `plugin/code.js`, dengan API Figma tiruan di `test/mock-figma.mjs`. Mock itu meniru aturan Figma yang sering bikin error (font harus dimuat, `FILL`/`HUG` hanya di tempat yang valid, semantik undo).

Versi plugin dan server didefinisikan di `src/protocol.ts`. Kalau versinya berbeda, setiap tool menambahkan peringatan supaya plugin dijalankan ulang.

## Batasan

- Figma harus terbuka dan plugin harus berjalan; tidak bisa headless.
- Hanya file yang sedang dibuka. Kalau plugin berjalan di beberapa file, perintah dikirim ke yang terakhir terhubung.
- Komentar, version history, dan daftar file/project tidak tersedia (itu hanya ada di REST API).
