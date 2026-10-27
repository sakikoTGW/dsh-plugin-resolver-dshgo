#!/bin/bash
set -u
cd /tmp
profile="$1"; tag="$2"; task="$3"
exec 9>/tmp/dsh-bench.lock
flock -w 1500 9 || { echo "LOCK_TIMEOUT"; exit 1; }
start=$(date +%s%3N)
env -u DSH_PROFILE -u DSH_PROFILE_DIR DSH_PERMISSION_MODE=danger-full-access timeout 900 dsh --profile "$profile" headless --json "$task" > "/tmp/run-$tag.jsonl" 2> "/tmp/run-$tag.err"
code=$?
end=$(date +%s%3N)
node -e '
const fs=require("fs");
const tag=process.argv[1], ms=Number(process.argv[2]), code=process.argv[3];
const lines=fs.readFileSync(`/tmp/run-${tag}.jsonl`,"utf8").split("\n").filter(Boolean);
let calls=[], usage={inputTokens:0,outputTokens:0,cacheReadTokens:0}, steps=0, final="";
for(const l of lines){ let o; try{o=JSON.parse(l)}catch{continue}
  if(o.type==="tool_call") calls.push(o.tool);
  if(o.type==="status"&&o.phase==="step_start") steps++;
  if(o.type==="status"&&o.usage) for(const k of Object.keys(usage)) if(typeof o.usage[k]==="number") usage[k]+=o.usage[k];
  if(o.type==="final") final=o.text;
}
const counts={}; for(const c of calls) counts[c]=(counts[c]||0)+1;
const summary={tag, profile:process.argv[4], wallSeconds:+(ms/1000).toFixed(1), exit:Number(code), steps, toolCalls:calls.length, tools:counts, tokens:usage, final:final.slice(0,400)};
fs.writeFileSync(`/tmp/summary-${tag}.json`, JSON.stringify(summary,null,1));
console.log(JSON.stringify(summary,null,1));
' "$tag" "$((end-start))" "$code" "$profile"
