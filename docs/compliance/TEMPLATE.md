# <Network> compliance report

Copy this file to `docs/compliance/<network>.md` and fill every section. Keep it factual: cite the network's own published rules, and point at code and tests for evidence.

| | |
|---|---|
| **Connection** | <Network> (<what Open Media does with it: read feed, post, chat, sign-in>) |
| **How it connects** | <API / protocol, auth method, scopes> |
| **Developer app** | <app name, owner account, where it is managed; "none" for open protocols> |
| **Secrets** | <names only; where they live (Worker secret, Infisical path)> |
| **Status** | <Live / Built, off / Planned> since <date> |
| **Last reviewed** | <YYYY-MM-DD> by <who> |
| **Next review** | <YYYY-MM-DD>, or sooner when the network changes its terms, API version or scopes |
| **Related ADRs** | <ADR numbers> |

## Summary

Two or three sentences: overall verdict, open gaps, anything that needs the owner.

## What Open Media accesses and keeps

| Data | Why | Where it lives | How long | How it is deleted |
|---|---|---|---|---|

## Requirements matrix

One row per rule. IDs are stable (`<NET>-01`, `<NET>-02`…) so answers and tickets can cite them. Status is **Complies**, **Gap**, **Partial**, **Not applicable** or **Unclear** (the source doesn't say).

| ID | Requirement | Source (retrieved date) | How Open Media complies | Evidence | Status |
|---|---|---|---|---|---|

## Gaps and remediation

| ID | Gap | Fix | Owner | Due | Done |
|---|---|---|---|---|---|

## Answers to common questions

Short, ready-to-send answers, each citing requirement IDs. Typical questions: What data do you access? Do you store it? How does a person disconnect and delete? Do you post without the person's approval? How are tokens and secrets protected? Which API version and scopes do you use?

## Sources

Every official page relied on, with the date it was read.

## Change log

| Date | Change |
|---|---|
