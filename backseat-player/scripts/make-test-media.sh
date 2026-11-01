#!/usr/bin/env bash
# Generates local test media that mirrors what YouTube serves, so the player
# engine can be tested without any network sources:
#   - dash-video-720.mp4 / dash-video-360.mp4: fragmented H.264 with sidx (like itags 136/134)
#   - dash-audio.mp4: fragmented AAC-LC with sidx (like itag 140)
#   - muxed.mp4: progressive faststart H.264+AAC (like itag 18)
# Output: public/test-media (git-ignored). Requires ffmpeg.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=public/test-media
DUR=${DUR:-75}
mkdir -p "$OUT"

SRC=(-f lavfi -i "testsrc2=size=1280x720:rate=30:duration=$DUR" -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=$DUR")
DASH=(-movflags +dash+global_sidx -frag_duration 5000000)

for H in 720 360; do
  ffmpeg -y -loglevel error "${SRC[@]:0:4}" -vf "scale=-2:$H" \
    -c:v libx264 -profile:v main -preset veryfast -g 60 -keyint_min 60 -sc_threshold 0 -bf 2 -pix_fmt yuv420p \
    -an "${DASH[@]}" "$OUT/dash-video-$H.mp4"
done

ffmpeg -y -loglevel error "${SRC[@]:4:4}" -c:a aac -b:a 128k -ac 2 "${DASH[@]}" "$OUT/dash-audio.mp4"

ffmpeg -y -loglevel error "${SRC[@]}" -vf scale=-2:360 \
  -c:v libx264 -profile:v baseline -preset veryfast -g 60 -pix_fmt yuv420p \
  -c:a aac -b:a 96k -ac 2 -movflags +faststart -shortest "$OUT/muxed.mp4"

ls -la "$OUT"
