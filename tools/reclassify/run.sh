#!/bin/sh
# The whole reclassification, on a GPU machine (RunPod). From the repository root:
#   sh tools/reclassify/run.sh            # every step
#   sh tools/reclassify/run.sh texts      # one step: texts | embed | propose | review
# Results in tools/reclassify/work/: changeset.json (to apply on the server) and review.html (to look at).
set -eu
cd "$(dirname "$0")"
step=${1:-all}
run() { echo "▶ $1"; python -u "$1.py" ${2:-}; }
[ "$step" = all ] || [ "$step" = texts ]   && run texts
[ "$step" = all ] || [ "$step" = embed ]   && run embed "--batch 256"
[ "$step" = all ] || [ "$step" = propose ] && run propose
[ "$step" = all ] || [ "$step" = review ]  && run review
echo "✓ Done: tools/reclassify/work/changeset.json and work/review.html"
