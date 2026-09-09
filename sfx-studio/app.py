"""
SFX On-Call Studio — local backend.

Freesound's API doesn't support browser CORS, so search has to be proxied
through this local server. Preview audio itself plays fine directly from
the browser (media elements aren't subject to CORS for playback), but
downloads are also proxied here so the browser's `download` attribute
behaves reliably regardless of the file's origin.

Setup:
    1. Get a free API key: https://freesound.org/apiv2/apply/
    2. export FREESOUND_API_KEY="your_key_here"
    3. pip install -r requirements.txt
    4. python app.py
    5. open http://localhost:5055
"""

import os
import requests
from flask import Flask, jsonify, request, send_from_directory, Response

FREESOUND_API_KEY = os.environ.get("FREESOUND_API_KEY", "")
FREESOUND_SEARCH_URL = "https://freesound.org/apiv2/search/text/"

# License strings Freesound uses. Default search restricts to these two so
# everything you pull back is safe to use without attribution headaches
# creeping into a parody/comedy channel later.
SAFE_LICENSES = '("Creative Commons 0" OR "Attribution")'

app = Flask(__name__, static_folder="static", static_url_path="")


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/search")
def search():
    if not FREESOUND_API_KEY:
        return jsonify({"error": "FREESOUND_API_KEY is not set on the server."}), 500

    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"error": "missing query"}), 400

    page = request.args.get("page", "1")
    sort = request.args.get("sort", "score")
    safe_only = request.args.get("safe", "1") != "0"
    max_duration = request.args.get("max_duration", "")

    filters = []
    if safe_only:
        filters.append(f"license:{SAFE_LICENSES}")
    if max_duration:
        filters.append(f"duration:[0 TO {max_duration}]")

    params = {
        "query": query,
        "page": page,
        "page_size": 30,
        "sort": sort,
        "fields": "id,name,previews,duration,license,tags,username,avg_rating",
        "token": FREESOUND_API_KEY,
    }
    if filters:
        params["filter"] = " ".join(filters)

    try:
        r = requests.get(FREESOUND_SEARCH_URL, params=params, timeout=15)
    except requests.RequestException as e:
        return jsonify({"error": f"Freesound request failed: {e}"}), 502

    if r.status_code != 200:
        return jsonify({"error": r.text}), r.status_code

    return jsonify(r.json())


@app.route("/api/download")
def download():
    """Streams a Freesound preview back through this server so the
    browser's native download attribute works regardless of cross-origin
    quirks, and so the same URL can be used for the drag-to-desktop trick."""
    url = request.args.get("url", "")
    filename = request.args.get("filename", "sfx.mp3")

    if not url.startswith("https://") or "freesound" not in url:
        return jsonify({"error": "invalid url"}), 400

    try:
        upstream = requests.get(url, stream=True, timeout=30)
    except requests.RequestException as e:
        return jsonify({"error": f"download failed: {e}"}), 502

    if upstream.status_code != 200:
        return jsonify({"error": "upstream fetch failed"}), 502

    return Response(
        upstream.iter_content(chunk_size=8192),
        content_type=upstream.headers.get("Content-Type", "audio/mpeg"),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


if __name__ == "__main__":
    if not FREESOUND_API_KEY:
        print(
            "\n[!] FREESOUND_API_KEY is not set.\n"
            "    export FREESOUND_API_KEY=your_key_here\n"
            "    (free key: https://freesound.org/apiv2/apply/)\n"
        )
    app.run(host="127.0.0.1", port=5055, debug=True)
