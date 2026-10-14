# Recording — current native capture and historical draft

## Continuous51 native screen recording

The current local-only recording is `reports/evaluation/continuous51-recording/video.mp4`. Independent ffprobe verified H.264, 1280×900, 24fps, 315 seconds (5:15), 7,560 encoded frames and 8,036,186 bytes. SHA-256: `00b7d2a8b870adadb10beb37873350a47fecb88aa69cf21ec478d4c0a1a76eb0`. Seven chapters contain 315 actual timestamped deployed-browser screenshots, not local fixtures or generated UI illustrations. Capture uses separate foreground Chromium lifetimes within the existing 60-second watchdog, closed before the next chapter. No login or owner decision is recorded.

The silent captioned video shows the public landing/tutorial, Artifacts-backed README repository, approved task/original failed review, replacement Checks/Files changed/Conversation, actual Next/Previous/tenant-B preview navigation and real Connect prompt clipboard readback. Commentary is visibly labeled separately from application state. This is edited: the expiring preview was captured first, then chapters were arranged in presentation order and browser-startup gaps omitted. It is not an uninterrupted session, a fresh agent implementation campaign or an arbitrary-code preview service. The prepared first-party source and actual independent Luna review/repair history remain distinct. Native final readback was ready for human review, not accepted, with unchanged catalog source.

Regenerate with `node --import tsx demo/cloud/record-demo.ts` in the supported Node/Chromium/bubblewrap environment with existing ffmpeg on PATH. It needs the sanitized fixed-fixture repository/candidate receipts referenced by the script; reports and media are intentionally absent from public-source snapshots. Explicit attended ingress/grant renewal and bounded preview refresh are separate operator procedures in candidate-smoke.md, never a perpetual process. The driver checks live source identity, refuses unavailable UI and persists completed matching chapters for resume. It must not invent an expired preview or use credentials in URLs/screenshots/manifests. Actual browser clipboard verification awaits the promise, focuses the isolated profile and uses a user gesture; no raw grant is copied.

The recording captures the frontend before the subsequent Connect prompt line-wrapping fix; it remains evidence of the version actually exercised, not of later unexecuted UI. No video upload, public GitHub publication, competition submission, human confirmation or final acceptance was performed or authorized. The older continuous35 draft below is retained as historical evidence only, not the current recording.

## Historical continuous35 evidence walkthrough

Status: `reports/evaluation/continuous35-walkthrough/walkthrough.mp4` was independently verified with ffprobe and decoded video frames: H.264, 1280×720, 2 fps, 320 seconds (5:20). This captioned draft combines historical cloud receipts with explicitly labeled automated local-fixture UI imagery. It is not a live cloud screen capture or a real human session. The final human segment remains unrecorded. SHA-256: `777221b98080f158fb51b66bf5b524aee96218250b5865c2c0312475ade5655a`.

## Evidence and boundaries

The historical cloud story is grounded in `reports/evaluation/continuous33-coordinator-verification.md` and the listed `continuous33-*.json` receipts in `reports/evaluation/`: exact replacement source, checks, focused composed-source race probe, independent review/finding/readiness and unchanged baseline. Receipts are historical and do not establish that an expiring endpoint is available now. During a repeated human window use `refresh`, not `checks`: checks are one-time mandatory suite execution; refresh advances source-verification and artifact versions under stable resource IDs while reading immutable historical checks and current readiness.

Local fixture screenshots are UI illustrations only. Label them automated/local fixture throughout; they do not prove remote operations, actual API/UI contributor collaboration, human feedback, login or acceptance. Do not stage/replay a human interaction or record tokens, private credential paths, unrelated local state, or login material.

## Intended 5:20 narrative

1. Distinguish the collaboration platform from the separate `demo/seed/` project-list sample.
2. Explain the original prepared-fixture candidate and the independently found stale-response race; passing API/UI checks did not expose that UI race.
3. Describe continuous32's actual reproduction and owner-authored repair, while noting its initial replacement composition was still pending.
4. Show continuous33's exact replacement View/source tuple, fresh passing mandatory API/UI checks, focused runtime probe, independent review, resolved finding and ready readback.
5. State limitations: one tenant-switch race ordering was runtime-probed; pagination overlap/reset and delayed body/error cases were source-reviewed only. Baseline unchanged; ready is not acceptance.
6. If showing review UI, visibly label automated local-fixture screenshots; human dashboard, diff/preview and optional request-changes are future actions, not performed events.
7. Close with expiry/freshness limits, no promise of live endpoint, and reserved human/publication decisions.

## Regeneration and verification

Run `node --import tsx demo/recording/walkthrough.ts reports/evaluation/continuous35-walkthrough` from a workspace containing the named historical receipts and fixture captures. The generator validates their relationships and hashes, freezes copies in the output's `inputs/` directory, and creates eight HTML pages, screenshots, `frames.ffconcat` and `provenance.json`. Encode with `ffmpeg -y -loglevel error -f concat -safe 0 -i reports/evaluation/continuous35-walkthrough/frames.ffconcat -t 320 -vf scale=1280:720:flags=fast_bilinear,fps=2 -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p reports/evaluation/continuous35-walkthrough/walkthrough.mp4`. Verify with `ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate -of json reports/evaluation/continuous35-walkthrough/walkthrough.mp4`. Run processes in the authorized foreground window only.

The source release deliberately excludes historical reports and generated media, so regenerating this specific walkthrough additionally requires its evidence inputs. Portable validator tests use synthetic samples and do not require those reports. The existing video bundle carries 20 hash-verified frozen inputs; `coordinator-verification.json` records independent input hashes, planned/measured duration and MP4 digest. Source assertions, local fixture illustrations, actual historical cloud operations and reserved human actions remain distinct. No live capture, voiceover, or human segment is implied.

- Verified draft MP4: `reports/evaluation/continuous35-walkthrough/walkthrough.mp4`.
- Human login/review/feedback recording: not recorded.
- Live-cloud screen segment: not recorded.
- Public publication/submission: requires separate authorization.
