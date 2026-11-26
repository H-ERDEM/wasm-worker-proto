/**
 * Claude masaüstü uygulaması için MCP yapılandırmasını bu bilgisayarın yollarıyla yazdırır.
 *
 *   npm run -s mcp-config
 *
 * Çıktı Claude → Ayarlar → Geliştirici → "Yapılandırmayı düzenle" ile açılan
 * claude_desktop_config.json dosyasına eklenir. Node'un tam yolu kullanılır, çünkü Claude
 * masaüstü uygulaması terminalin PATH'ini (nvm, Homebrew) görmez.
 */
import { fileURLToPath } from "node:url";

const stdio = fileURLToPath(new URL("../mcp/stdio.ts", import.meta.url));
const url = process.env.COORDINATOR_URL ?? "http://127.0.0.1:8787";

const config = {
  mcpServers: {
    "gonullu-hesaplama": {
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", stdio],
      env: { COORDINATOR_URL: url },
    },
  },
};

console.log(JSON.stringify(config, null, 2));
