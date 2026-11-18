---
description: Connect an email account or a chat app (WhatsApp, Signal, Telegram …) to your Open Media inbox
argument-hint: "[e.g. my gmail, whatsapp]"
---

Connect $ARGUMENTS to my Open Media inbox.

Use the open-media-inbox skill. For email, ask for the mailbox settings and an app password (never my main password), then `connect_mailbox`. For a chat app, warn me first that the network does not approve bridges, then `chat_network_sign_in_options` and `start_chat_network_sign_in`, showing me each step (such as a QR code). Show what is connected now with `list_mailboxes` and `list_chat_networks`.
