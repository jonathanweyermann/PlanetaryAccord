"""Package the game and its assets into Planetary Accord.html."""

import base64
import json
import re
from pathlib import Path
from tempfile import NamedTemporaryFile


ROOT = Path(__file__).resolve().parents[1]
IMPORTS = re.compile(r"""(\bfrom\s*|\bimport\s*\(\s*)(['"])(\./[^'"]+\.(?:mjs|js))\2""")
ASSETS = re.compile(r"""new URL\(\s*(['"])(\./assets/[^'"]+\.(?:jpg|json))\1,\s*import\.meta\.url\s*\)\.href""")
ASSET_TYPES = {".jpg": "image/jpeg", ".json": "application/json"}
LOADER = """<script type="module">
    const modules = MODULE_SOURCES;
    const paths = new Map();
    for (const [name, [original, imports]] of Object.entries(modules)) {
      let source = original;
      for (const [token, target] of Object.entries(imports)) {
        source = source.replaceAll(token, paths.get(target));
      }
      paths.set(name, URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    }
    import(paths.get('main.mjs')).catch((error) => {
      console.error(error);
      const message = document.getElementById('load-error');
      message.textContent = 'The game could not load. Open this file in a browser with WebGL 2 support.';
      message.hidden = false;
    });
  </script>"""


def build():
    modules = {}

    def collect(path):
        name = path.relative_to(ROOT).as_posix()
        if name in modules:
            return name
        source = path.read_text(encoding="utf-8")
        if name == "main.mjs":
            source = source.replace("get('seed');", "get('seed') ?? '3769694225';")
        imports = {}

        def map_import(match):
            prefix, quote, imported = match.groups()
            target = collect((path.parent / imported).resolve())
            token = f"__ACCORD_IMPORT_{len(imports)}__"
            imports[token] = target
            return f"{prefix}{quote}{token}{quote}"

        def embed_asset(match):
            asset = path.parent / match.group(2)
            data = base64.b64encode(asset.read_bytes()).decode("ascii")
            return json.dumps(f"data:{ASSET_TYPES[asset.suffix]};base64,{data}")

        source = IMPORTS.sub(map_import, source)
        modules[name] = [ASSETS.sub(embed_asset, source), imports]
        return name

    collect(ROOT / "main.mjs")
    payload = json.dumps(modules, ensure_ascii=True).replace("<", "\\u003c")
    script = LOADER.replace("MODULE_SOURCES", payload)
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "style.css").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="./style.css">', f"<style>\n{css}\n</style>")
    html, scripts = re.subn(r'<script type="module">.*?</script>', lambda _: script, html, flags=re.S)
    if scripts != 1:
        raise ValueError("Expected one module loader in index.html")

    output = ROOT / "Planetary Accord.html"
    with NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=ROOT, prefix=".accord-", suffix=".html", delete=False) as file:
        file.write(html)
    Path(file.name).replace(output)
    print(f"{output.name} contains {len(modules)} modules with embedded assets.")


if __name__ == "__main__":
    build()
