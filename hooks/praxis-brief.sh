#!/bin/bash
# SessionStart hook: inject the praxis brief (what the studio knows about the
# user's current work) into a fresh Claude Code session. Same stdin/stdout
# contract as boardroom/hooks/session-start.sh — JSON on stdin, on stdout
# {hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:"..."}}.
#
# Unlike the boardroom hook there is NO fail-closed guidance here: the brief is
# pure context, so when the studio is down, slow, answers garbage, or simply
# has nothing to say, we emit NOTHING and exit 0 — the session starts exactly
# as it would without this hook installed. Never block startup.
#
# Studio base URL: PRAXIS_STUDIO_URL when set (tests inject a stub server this
# way), else the studio default 127.0.0.1:4319.
base="${PRAXIS_STUDIO_URL:-http://127.0.0.1:4319}"
input=$(cat)

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

enc() { printf '%s' "$1" | jq -sRr '@uri' 2>/dev/null; }

# One 2s shot, no retries — a cold/down studio must cost at most 2 seconds.
brief=$(curl -s -m 2 "${base%/}/api/brief?cwd=$(enc "$cwd")" 2>/dev/null) || brief=""
[ -z "$brief" ] && exit 0

# Digest the JSON into markdown. jq -e exits non-zero when the program yields
# `empty`, so non-JSON bodies AND contentless briefs both land in the fail-open
# arm. Sections (focus / claims / open questions) are dropped individually when
# empty; when all are empty there is no brief to inject.
md=$(printf '%s' "$brief" | jq -er '
  if type == "object" then
    [ (.episodeGoal // "" | select(. != "") | "Current focus: " + .),
      (((.topClaims // []) | map(.text // "" | select(. != ""))) as $c
        | if ($c | length) > 0
          then "What praxis already knows (relevant claims):\n" + ($c | map("- " + .) | join("\n"))
          else empty end),
      (((.openQuestions // []) | map(.question // "" | select(. != ""))) as $q
        | if ($q | length) > 0
          then "Open questions praxis is waiting on (answer in the studio, or here if asked):\n" + ($q | map("- " + .) | join("\n"))
          else empty end)
    ] | if length > 0 then join("\n\n") else empty end
  else empty end' 2>/dev/null) || md=""
[ -z "$md" ] && exit 0

ctx="## Your praxis brief
${md}"

jq -nc --arg ctx "$ctx" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
