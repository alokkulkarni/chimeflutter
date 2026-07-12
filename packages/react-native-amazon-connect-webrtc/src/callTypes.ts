import type { CallType } from './types';

/** Parses `"audio,video"` / `"audio"` / `"video"` (case- and space-tolerant). Empty or
 *  unrecognised input falls back to both — a typo must never remove the ability to call.
 *  Parity with the Flutter module's `AppConfig.parseCallTypes`. */
export function parseEnabledCallTypes(raw: string | undefined): Set<CallType> {
  const tokens = new Set(
    (raw ?? '')
      .toLowerCase()
      .split(',')
      .map((t) => t.trim()),
  );
  const types = new Set<CallType>();
  if (tokens.has('audio')) types.add('audio');
  if (tokens.has('video')) types.add('video');
  return types.size === 0 ? new Set<CallType>(['audio', 'video']) : types;
}

/** Non-null when exactly one call type is enabled — the type to dial without showing a chooser. */
export function soleCallType(types: ReadonlySet<CallType>): CallType | null {
  return types.size === 1 ? [...types][0]! : null;
}
