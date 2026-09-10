/**
 * exportdlg.js — the export dialog.
 *
 * Two clicks from "I'm done" to "file in my Downloads": pick a preset, hit
 * Export. Everything else (loudness target, ceiling, bitrate, sample rate,
 * filename) is decided by the preset, which is the whole point of an
 * opinionated export path.
 */

import { EXPORT_PRESETS, exportProject } from "../audio/render.js";
import { downloadBlob, esc, formatBytes, formatDb, safeFilename, isoDate } from "../util.js";
import { progressOverlay, toastError, toastOk } from "./toast.js";

export function openExportDialog(project, takeCache, { defaultPreset = "reels" } = {}) {
  const el = document.createElement("div");
  el.className = "overlay";
  el.innerHTML = `
    <div class="overlay-card overlay-wide">
      <h3>Export</h3>
      <div class="ex-presets">
        ${Object.values(EXPORT_PRESETS)
          .map(
            (p) => `
          <label class="ex-preset ${p.id === defaultPreset ? "is-on" : ""}">
            <input type="radio" name="ex-preset" value="${p.id}" ${p.id === defaultPreset ? "checked" : ""} />
            <span class="ex-preset-label">${esc(p.label)}</span>
            <span class="ex-preset-hint">${esc(p.hint)}</span>
          </label>`,
          )
          .join("")}
      </div>

      <label class="sfx-check ex-chain">
        <input type="checkbox" class="ex-apply-chain" checked />
        <span>Run the voice chain on the voice track</span>
      </label>
      <label class="sfx-check">
        <input type="checkbox" class="ex-report" checked />
        <span>Save a loudness report alongside it</span>
      </label>

      <div class="ex-filename">
        <span>Saves as</span>
        <code class="ex-fn"></code>
      </div>

      <div class="ex-result" hidden></div>

      <div class="overlay-actions">
        <button class="btn-ghost" data-act="cancel">Close</button>
        <button class="btn" data-act="export">Export</button>
      </div>
    </div>`;

  document.body.appendChild(el);

  const fnEl = el.querySelector(".ex-fn");
  const resultEl = el.querySelector(".ex-result");

  const currentPreset = () =>
    EXPORT_PRESETS[el.querySelector('input[name="ex-preset"]:checked').value];

  const updateName = () => {
    const p = currentPreset();
    const ext = p.format === "mp3" ? "mp3" : "wav";
    fnEl.textContent = `${safeFilename(project.name)}_${isoDate()}_${p.suffix}.${ext}`;
    el.querySelectorAll(".ex-preset").forEach((l) =>
      l.classList.toggle("is-on", l.querySelector("input").checked),
    );
  };
  updateName();
  el.querySelectorAll('input[name="ex-preset"]').forEach((r) =>
    r.addEventListener("change", updateName),
  );

  el.addEventListener("click", async (e) => {
    const act = e.target.dataset?.act;
    if (act === "cancel") {
      el.remove();
      return;
    }
    if (act !== "export") return;

    const preset = currentPreset();
    const applyChain = el.querySelector(".ex-apply-chain").checked;
    const wantReport = el.querySelector(".ex-report").checked;

    const prog = progressOverlay(`Exporting — ${preset.label}`);
    try {
      const { blob, filename, report } = await exportProject(project, takeCache, preset, {
        applyChain,
        onProgress: (p, label) => prog.update(p, label),
      });
      prog.close();
      downloadBlob(blob, filename);

      if (wantReport) {
        const reportBlob = new Blob([JSON.stringify(report, null, 2)], {
          type: "application/json",
        });
        downloadBlob(reportBlob, filename.replace(/\.(mp3|wav)$/, ".loudness.json"));
      }

      resultEl.hidden = false;
      resultEl.innerHTML = `
        <div class="ex-result-grid">
          <div><span>Integrated</span><b>${formatDb(report.measuredAfterLufs)} LUFS</b></div>
          <div><span>Target</span><b>${report.targetLufs ?? "—"} LUFS</b></div>
          <div><span>True peak</span><b>${formatDb(report.truePeakDbtp)} dBTP</b></div>
          <div><span>Gain applied</span><b>${formatDb(report.appliedGainDb)} dB</b></div>
          <div><span>Length</span><b>${report.durationSec}s</b></div>
          <div><span>Size</span><b>${formatBytes(report.fileBytes)}</b></div>
        </div>`;
      toastOk(`Exported ${filename}`);
    } catch (err) {
      prog.close();
      console.error(err);
      toastError(err.message || "Export failed");
    }
  });

  return el;
}
