#!/usr/bin/env bash
# Builds the piano samples in src/web/public/samples/piano from the
# Salamander Grand Piano V3 (Alexander Holm, CC BY 3.0), via the MP3
# packages published as @audio-samples/piano-mp3-*.
#
# Samples are trimmed (a piano's tail is inaudible long before the
# recording ends), faded out and re-encoded, which keeps the download and
# the decoded memory footprint small.
set -euo pipefail

OUT="$(cd "$(dirname "$0")/.." && pwd)/src/web/public/samples/piano"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Salamander velocity layer -> our layer name (soft, medium, loud)
declare -A LAYERS=([4]=p [10]=mf [15]=f)
NAMES=(C Cs D Ds E F Fs G Gs A As B)

midi_of() { # A0 -> 21, D#4 -> 63
  local n="${1%[0-9]}" o="${1: -1}" i
  for i in "${!NAMES[@]}"; do [[ "${NAMES[$i]}" == "${n/\#/s}" ]] && echo $(( (o + 1) * 12 + i )); done; return 0
}

length_for() { # seconds kept per register: bass rings longest
  if (( $1 < 48 )); then echo 9; elif (( $1 < 72 )); then echo 6; else echo 4; fi
}

rm -rf "$OUT" && mkdir -p "$OUT/release"
cd "$WORK"
for v in "${!LAYERS[@]}"; do
  name="${LAYERS[$v]}"
  npm pack --silent "@audio-samples/piano-mp3-velocity$v@1.0.5" >/dev/null
  mkdir -p "v$v" && tar xzf audio-samples-piano-mp3-velocity$v-1.0.5.tgz -C "v$v"
  mkdir -p "$OUT/$name"
  for f in "v$v"/package/audio/*.mp3; do
    note="$(basename "$f" .mp3)"; note="${note%v$v}"
    midi="$(midi_of "$note")"; len="$(length_for "$midi")"
    ffmpeg -loglevel error -y -i "$f" -t "$len" -af "afade=t=out:st=$((len - 2)):d=2" -b:a 112k "$OUT/$name/$midi.mp3"
  done
done

npm pack --silent "@audio-samples/piano-mp3-release@1.0.5" >/dev/null
mkdir -p rel && tar xzf audio-samples-piano-mp3-release-1.0.5.tgz -C rel
for i in $(seq 1 88); do
  ffmpeg -loglevel error -y -i "rel/package/audio/rel$i.mp3" -t 1.5 -af "afade=t=out:st=1:d=0.5" -b:a 96k "$OUT/release/$((i + 20)).mp3"
done

cat > "$OUT/LICENSE.md" <<'TXT'
# Piano samples

Salamander Grand Piano V3 by Alexander Holm, licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
Source: https://archive.org/details/SalamanderGrandPianoV3

Changes: three velocity layers (Salamander layers 4, 10 and 15) and the key-release
samples, trimmed, faded out and re-encoded to MP3 by `scripts/build-piano-samples.sh`.
Files are named by MIDI note number.
TXT
du -sh "$OUT"
