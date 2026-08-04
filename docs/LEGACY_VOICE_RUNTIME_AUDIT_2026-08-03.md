# Legacy Voice Runtime Audit

Date: 2026-08-03

## Runtime bindings

### Upload

- API: `POST /voice/upload` on `shirone7-api`;
- Gateway authorizer: none;
- Lambda: `shirone7-voice-upload`;
- session-secret configuration: present;
- Users: `shirone7_users`;
- History: `shirone7_history`;
- S3: `shirone7-voice-poc-001`;
- Transcribe configuration: enabled through Lambda environment/IAM;
- source behavior: Bearer verification and quota pre-check.

### Processing

- S3 event `transcript/member/*.json` invokes `shirone7-voice-result`;
- Users: `shirone7_users`;
- History: `shirone7_history`;
- input/result bucket: `shirone7-voice-poc-001`;
- Bedrock invoke permission exists;
- source behavior: complete History, then consume a Voice counter.

An older parallel path remains: S3 `raw/` puts invoke
`shirone7-voice-poc`. Its exact deployed behavior was not inspected.

## State machine

```text
POST /voice/upload
  -> Bearer/session verification in repository source
  -> Users GetItem quota pre-check
  -> S3 upload
  -> Transcribe start
  -> History PutItem(processing)
  -> transcript/member/*.json S3 event
  -> Voice result Lambda
  -> History lookup (source includes scan fallback)
  -> Bedrock/result generation
  -> History UpdateItem(completed)
  -> Users GetItem
  -> monthly_voice_used +1 OR extra_voice_remaining -1
```

## Safety assessment

Runtime configuration confirms that the weak source design is connected to the
production-named legacy Users, History and Voice bucket. Exact deployed-code
hash parity was not established because source-package/object reads were
prohibited.

| Invariant | Evidence |
| --- | --- |
| reservation before processing | absent in repository source |
| concurrent pre-check safety | not provided by separate GetItem/check |
| duplicate processor delivery | no durable completion ledger in source |
| History and quota atomic | separate updates, not one transaction |
| failure releases reservation | no reservation exists |
| monthly consume conditional | source re-reads counters, then updates |
| extra consume conditional | source checks then updates separately |

Verdict:

```text
LEGACY_VOICE_SOURCE_WEAK_RUNTIME_BINDINGS_CONFIRMED
DEPLOYED_CODE_PARITY_NOT_VERIFIED
```

This does not authorize reopening the Voice UI.

## IAM observations

- upload role is same-account for Users, History and S3;
- Transcribe actions use wildcard Resource;
- result role is same-account for Users, History and S3;
- Bedrock/Marketplace actions use wildcard Resource;
- result role retains History `Scan` permission;
- no cross-account dependency was found.

## Required replacement properties

- `NO_DOUBLE_CONSUME`
- `NO_OVERBOOK`
- `FAILED_JOB_RELEASES_RESERVATION`
- `HISTORY_AND_CONSUME_ATOMIC_OR_RECOVERABLE`
- explicit separation of uploaded consultation and future TTS products
