// `bun run demo:web:build`: writes the page as static files to apps/demo-web/dist, for hosting it
// apart from the service (for example under the project site). DEMO_API_URL is the service's public
// origin; the service must then list the page's origin in DEMO_ALLOWED_ORIGINS.
// Not needed when the service serves the page itself (the recommended demo.p-x402.com setup).
import { join } from "node:path"

const apiUrl = Bun.env.DEMO_API_URL?.trim() ?? ""
if (apiUrl && (!URL.canParse(apiUrl) || new URL(apiUrl).origin !== apiUrl.replace(/\/+$/, ""))) {
  console.error("DEMO_API_URL must be an origin like https://api.p-x402.com")
  process.exit(1)
}

const outdir = join(import.meta.dir, "..", "dist")
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "web", "index.html")],
  outdir,
  minify: true,
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const htmlPath = join(outdir, "index.html")
const html = await Bun.file(htmlPath).text()
const marker = '<meta name="px402-api" content="">'
if (!html.includes(marker)) {
  console.error("build: the px402-api meta tag is missing from index.html")
  process.exit(1)
}
await Bun.write(
  htmlPath,
  html.replace(marker, `<meta name="px402-api" content="${apiUrl.replace(/\/+$/, "")}">`),
)
console.log(
  `build: ${result.outputs.length} arquivos em ${outdir} (API: ${apiUrl || "mesma origem"})`,
)
