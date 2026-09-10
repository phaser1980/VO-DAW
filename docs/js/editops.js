/**
 * editops.js — non-destructive edit operations.
 *
 * Every function here is a pure-ish operation over Clip/Track objects. None
 * of them read or write audio: a split just rewrites two clips' in/out
 * points, a fade just sets a duration. Audio is only ever touched when
 * something needs to *hear* it (playback) or *render* it (export).
 *
 * This mirrors core/edit_ops.py in the desktop app one-for-one, so a project
 * edited in either place behaves the same.
 */

import { clipDuration, clipEnd, makeClip, sortClips } from "./model.js";
import { uid } from "./util.js";

/**
 * Split every clip on `track` that spans `atSec`.
 * @returns {number} how many clips were split
 */
export function splitAt(track, atSec) {
  let count = 0;
  const added = [];
  for (const clip of track.clips) {
    const start = clip.startSec;
    const end = clipEnd(clip);
    if (atSec <= start + 0.001 || atSec >= end - 0.001) continue;

    const offset = atSec - start; // seconds into the clip
    const right = makeClip({
      takeId: clip.takeId,
      name: clip.name,
      startSec: atSec,
      sourceInSec: clip.sourceInSec + offset,
      sourceOutSec: clip.sourceOutSec,
      gainDb: clip.gainDb,
      fadeInSec: 0.003,
      fadeOutSec: clip.fadeOutSec,
    });
    clip.sourceOutSec = clip.sourceInSec + offset;
    clip.fadeOutSec = Math.min(clip.fadeOutSec, 0.003);
    added.push(right);
    count++;
  }
  track.clips.push(...added);
  sortClips(track);
  return count;
}

/**
 * Remove [startSec, endSec) from a track. With `ripple`, everything after the
 * range slides left to close the gap — the edit that makes cutting a fluffed
 * line actually usable.
 */
export function deleteRange(track, startSec, endSec, { ripple = false } = {}) {
  const len = endSec - startSec;
  if (len <= 0) return 0;
  let removed = 0;
  const out = [];

  for (const clip of track.clips) {
    const cs = clip.startSec;
    const ce = clipEnd(clip);

    if (ce <= startSec || cs >= endSec) {
      out.push(clip); // untouched
      continue;
    }
    removed++;

    if (cs >= startSec && ce <= endSec) continue; // fully inside — drop it

    if (cs < startSec && ce > endSec) {
      // Range sits inside the clip: keep head, add tail.
      const headLen = startSec - cs;
      const tail = makeClip({
        takeId: clip.takeId,
        name: clip.name,
        startSec: endSec,
        sourceInSec: clip.sourceInSec + (endSec - cs),
        sourceOutSec: clip.sourceOutSec,
        gainDb: clip.gainDb,
        fadeInSec: 0.003,
        fadeOutSec: clip.fadeOutSec,
      });
      clip.sourceOutSec = clip.sourceInSec + headLen;
      clip.fadeOutSec = Math.min(clip.fadeOutSec, 0.003);
      out.push(clip, tail);
      continue;
    }

    if (cs < startSec) {
      // Trim the tail off.
      clip.sourceOutSec = clip.sourceInSec + (startSec - cs);
      clip.fadeOutSec = Math.min(clip.fadeOutSec, 0.003);
      out.push(clip);
      continue;
    }

    // cs >= startSec, ce > endSec — trim the head off.
    const cut = endSec - cs;
    clip.sourceInSec += cut;
    clip.startSec = endSec;
    clip.fadeInSec = Math.min(clip.fadeInSec, 0.003);
    out.push(clip);
  }

  track.clips = out.filter((c) => clipDuration(c) > 0.001);

  if (ripple) {
    for (const clip of track.clips) {
      if (clip.startSec >= endSec - 0.0001) clip.startSec = Math.max(0, clip.startSec - len);
    }
  }

  sortClips(track);
  return removed;
}

/** Ripple-delete across every track at once — keeps tracks in sync. */
export function rippleDeleteAll(project, startSec, endSec) {
  let n = 0;
  for (const track of project.tracks) n += deleteRange(track, startSec, endSec, { ripple: true });
  const len = endSec - startSec;
  for (const m of project.markers) if (m.timeSec >= endSec) m.timeSec -= len;
  return n;
}

/** Insert silence at `atSec`, pushing everything after it later. */
export function insertSilence(project, atSec, lengthSec) {
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.startSec >= atSec - 0.0001) clip.startSec += lengthSec;
    }
    sortClips(track);
  }
  for (const m of project.markers) if (m.timeSec >= atSec) m.timeSec += lengthSec;
}

/** Symmetrical crossfade between two adjacent clips. */
export function crossfade(track, clipA, clipB, durationSec = 0.05) {
  const a = track.clips.find((c) => c.id === clipA.id);
  const b = track.clips.find((c) => c.id === clipB.id);
  if (!a || !b) return false;
  const [first, second] = a.startSec <= b.startSec ? [a, b] : [b, a];
  const overlap = clipEnd(first) - second.startSec;
  const dur = Math.min(durationSec, clipDuration(first) / 2, clipDuration(second) / 2);

  if (overlap < dur) {
    // Pull the second clip back so there's something to fade across.
    second.startSec = clipEnd(first) - dur;
  }
  first.fadeOutSec = dur;
  second.fadeInSec = dur;
  sortClips(track);
  return true;
}

/**
 * Comp: replace [startSec, endSec) on `track` with the matching stretch of
 * `takeId`. This is the "keep the third take's second sentence" move.
 */
export function compRange(track, startSec, endSec, take, { sourceOffsetSec = 0 } = {}) {
  deleteRange(track, startSec, endSec, { ripple: false });
  const len = endSec - startSec;
  const clip = makeClip({
    takeId: take.id,
    name: `${take.name} (comp)`,
    startSec,
    sourceInSec: sourceOffsetSec,
    sourceOutSec: Math.min(take.durationSec, sourceOffsetSec + len),
    fadeInSec: 0.008,
    fadeOutSec: 0.008,
  });
  track.clips.push(clip);
  sortClips(track);
  return clip;
}

/** Duplicate a clip immediately after itself. */
export function duplicateClip(track, clip) {
  const copy = makeClip({
    ...clip,
    id: uid("clip"),
    startSec: clipEnd(clip),
  });
  track.clips.push(copy);
  sortClips(track);
  return copy;
}

/** Nudge a clip in time, clamped at zero. */
export function nudgeClip(clip, deltaSec) {
  clip.startSec = Math.max(0, clip.startSec + deltaSec);
}

/**
 * Close every gap on a track, butting clips end-to-end from `fromSec`.
 * Useful after cutting a lot of fluffs out of a read.
 */
export function closeGaps(track, fromSec = 0) {
  sortClips(track);
  let cursor = fromSec;
  for (const clip of track.clips) {
    if (clip.startSec < fromSec) {
      cursor = Math.max(cursor, clipEnd(clip));
      continue;
    }
    clip.startSec = cursor;
    cursor = clipEnd(clip);
  }
}
