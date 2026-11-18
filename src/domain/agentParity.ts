/**
 * Agent parity: everything a person can do in the Open Media app, an agent can do through the
 * plugin's MCP tools, unless there is a stated reason it must not (ADR 0043).
 *
 * Each capability names its sources: the REST operations (`METHOD /path`, as in /v1/openapi.json)
 * and the app's data functions (`file.function`, from src/data, the mail, AI and bridge connectors
 * and src/auth/accountSecurity.ts) that implement it. The Worker test agentParity.test.ts fails when
 * - a REST operation or an app data function is in no capability (a new feature with no decision),
 * - a capability names a tool the MCP servers don't register, or
 * - a capability has neither tools nor a reason.
 * So a new screen or route can't ship without either a tool or a written reason here.
 */

export type NoToolReason =
  /** The setting or state lives only on the person's device (AsyncStorage, the mic, files). */
  | 'device'
  /** It is signed with keys that never leave the person's device (network keys, wallets). */
  | 'device-keys'
  /** An agent must never handle it: passwords, passkeys, authenticator codes, API keys. */
  | 'secret'
  /** A file picked on the device; agents use the REST upload instead. */
  | 'upload'
  /** Apps signed in with Open Media (agents included) may not manage other apps (ADR 0041). */
  | 'apps-only'
  /** Plumbing, not a capability a person uses (webhooks, realtime tokens, configuration). */
  | 'internal';

export interface AppCapability {
  area: string;
  capability: string;
  sources: string[];
  tools?: string[];
  noTool?: { kind: NoToolReason; reason: string };
}

const can = (area: string, capability: string, sources: string[], tools: string[]): AppCapability => ({ area, capability, sources, tools });
const cannot = (area: string, capability: string, sources: string[], kind: NoToolReason, reason: string): AppCapability => ({ area, capability, sources, noTool: { kind, reason } });

export const appCapabilities: AppCapability[] = [
  // Signing in
  can('sign-in', 'Sign in with an emailed code and stay signed in', ['POST /v1/auth/email-code', 'POST /v1/auth/verify', 'POST /v1/auth/refresh'], ['request_sign_in_code', 'sign_in_with_code', 'refresh_sign_in']),
  cannot('sign-in', 'Sign out of this device', ['POST /v1/auth/sign-out'], 'internal', 'Agents sign in with OAuth; disconnecting is done in the host or by signing out in the app, which ends the agent’s grant.'),
  cannot('sign-in', 'Passwords, passkeys, authenticator app and recovery codes', ['POST /v1/auth/recovery', 'accountSecurity.signInWithPassword', 'accountSecurity.signUpWithPassword', 'accountSecurity.confirmSignUp', 'accountSecurity.sendPasswordResetCode', 'accountSecurity.resetPasswordWithCode', 'accountSecurity.passwordResetWaitingForPasskey', 'accountSecurity.forgetPendingPasswordReset', 'accountSecurity.hasPassword', 'accountSecurity.setPassword', 'accountSecurity.passkeysSupportedHere', 'accountSecurity.listPasskeys', 'accountSecurity.addPasskey', 'accountSecurity.removePasskey', 'accountSecurity.passkeyStepNeeded', 'accountSecurity.authenticatorStepFactor', 'accountSecurity.completeAuthenticatorStep', 'accountSecurity.completePasskeyStep', 'accountSecurity.signInPasskeysSupportedHere', 'accountSecurity.listSignInPasskeys', 'accountSecurity.addSignInPasskey', 'accountSecurity.renameSignInPasskey', 'accountSecurity.removeSignInPasskey', 'accountSecurity.authenticatorApp', 'accountSecurity.startAuthenticatorApp', 'accountSecurity.confirmAuthenticatorApp', 'accountSecurity.cancelAuthenticatorApp', 'accountSecurity.removeAuthenticatorApp', 'accountSecurity.recoveryCodesLeft', 'accountSecurity.newRecoveryCodes', 'accountSecurity.needsSecondStepFirst'], 'secret', 'Sign-in secrets and WebAuthn ceremonies belong to the person and their device; an agent that could change them could take over the account.'),
  cannot('sign-in', 'See and disconnect apps signed in with Open Media', ['GET /v1/me/apps', 'DELETE /v1/me/apps/{grantId}', 'accountSecurity.listConnectedApps', 'accountSecurity.disconnectApp'], 'apps-only', 'An app (an agent included) must not list or revoke other apps; the REST route refuses connected callers too.'),

  // Profile and identity
  can('profile', 'Create a profile (name and @handle)', ['PUT /v1/me/profile'], ['set_up_profile']),
  can('profile', 'See my profile', ['GET /v1/me', 'openMediaService.getCurrentProfile'], ['get_me']),
  can('profile', 'Edit my name and bio', ['openMediaService.saveCurrentProfile', 'openMediaService.saveProfileBasics'], ['edit_profile']),
  cannot('profile', 'Choose a profile picture or Gravatar', ['avatarUpload.pickAvatar', 'avatarUpload.findGravatar', 'avatarUpload.uploadAvatar', 'avatarFiles.readPickedImage'], 'upload', 'The picture is a file picked on the device and uploaded to storage; there is no URL-only path to keep pictures safe.'),
  can('profile', 'Profile fields (location, links, contact) and who sees them', ['GET /v1/me/profile-fields', 'PUT /v1/me/profile-fields', 'openMediaService.loadMyProfileFields', 'openMediaService.saveMyProfileFields'], ['get_profile_fields', 'set_profile_fields']),
  can('profile', 'Accounts elsewhere on my profile', ['PUT /v1/me/linked-accounts', 'peopleService.saveLinkedAccounts'], ['set_linked_accounts']),
  can('profile', 'Professional profile, and importing it from a resume, LinkedIn or a website', ['GET /v1/me/professional', 'PUT /v1/me/professional', 'POST /v1/me/professional/import', 'POST /v1/me/professional/portfolio', 'openMediaService.saveProfessionalProfile', 'openMediaService.loadProfessionalProfile', 'profileImportService.importFromLinkedInFiles', 'profileImportService.importFromWebsite'], ['get_professional_profile', 'set_professional_profile', 'import_resume', 'import_portfolio']),
  cannot('profile', 'Read import files from the device', ['profileImportFiles.readFileBase64', 'profileImportFiles.readFileText', 'profileImportFiles.csvFilesInZip'], 'device', 'File reading on the device; import_resume takes the file’s contents.'),
  can('profile', 'Someone’s public resume', ['GET /v1/profiles/{handle}/resume', 'GET /v1/profiles/{handle}/resume.json', 'GET /v1/profiles/{handle}/resume.yaml', 'peopleService.resumeUrl'], ['get_resume']),
  can('identity', 'Name others see, private account, identity verification', ['GET /v1/me/identity', 'PUT /v1/me/identity', 'POST /v1/me/verification', 'peopleService.loadMyIdentity', 'peopleService.saveMyIdentity', 'peopleService.startIdentityVerification'], ['get_my_identity', 'set_my_privacy', 'start_identity_verification']),
  can('account', 'Export my data', ['GET /v1/me/export', 'openMediaService.exportCurrentAccountData'], ['export_my_data']),
  can('account', 'Delete my account', ['DELETE /v1/me', 'openMediaService.deleteCurrentAccount'], ['delete_my_account']),

  // People
  can('people', 'View a profile and a person’s posts across networks', ['GET /v1/profiles/{handle}', 'GET /v1/profiles/{handle}/posts', 'GET /v1/people/{network}/{handle}', 'peopleService.loadPublicPerson', 'peopleService.sourcesFor', 'peopleService.loadTimeline'], ['get_profile', 'get_person_timeline']),
  can('people', 'Find people on Open Media', ['openMediaService.searchOpenMediaProfiles'], ['find_people']),
  can('people', 'Follow, unfollow, follow requests and followers', ['GET /v1/me/follows', 'POST /v1/me/follows', 'DELETE /v1/me/follows/{handle}', 'POST /v1/me/follow-requests/{id}', 'DELETE /v1/me/followers/{id}', 'peopleService.followPerson', 'peopleService.unfollowPerson', 'peopleService.loadMyFollows', 'peopleService.answerFollowRequest', 'peopleService.removeFollower'], ['list_my_follows', 'follow', 'unfollow', 'answer_follow_request', 'remove_follower']),
  can('people', 'Block or unblock someone', ['POST /v1/me/blocks', 'openMediaService.listBlockedUserIds', 'openMediaService.setUserBlocked'], ['block_person']),

  // Contacts
  can('contacts', 'List, add, edit and delete contacts', ['GET /v1/me/contacts', 'PUT /v1/me/contacts', 'DELETE /v1/me/contacts/{id}', 'peopleService.loadContactCards', 'peopleService.saveContactCards', 'peopleService.deleteContactCard'], ['list_my_contacts', 'save_contacts', 'delete_contact']),
  can('contacts', 'Find which contacts are on Open Media', ['POST /v1/me/contacts/discover', 'peopleService.discoverAccounts'], ['find_contacts_on_open_media']),
  cannot('contacts', 'Import or export a contacts file', ['contactImportFiles.pickContactsFiles', 'contactExportFiles.saveContactsFile'], 'device', 'Picking and saving files happens on the device; agents read and write the same cards with list_my_contacts and save_contacts.'),

  // Feed and algorithm
  can('feed', 'Read the public Feed', ['GET /v1/feed', 'GET /v1/posts', 'postService.loadPublicPosts'], ['get_feed']),
  can('feed', 'Read my Feed through my lens', ['GET /v1/me/feed'], ['get_my_feed']),
  can('feed', 'Read one post', ['GET /v1/posts/{id}'], ['get_post']),
  can('feed', 'Search everything public', ['GET /v1/search', 'POST /v1/search/assist'], ['search']),
  can('feed', 'Networks Open Media reads', ['GET /v1/networks'], ['list_networks']),
  can('algorithm', 'Shared lenses: browse, read, draft, preview and audit', ['GET /v1/lenses', 'GET /v1/lenses/{id}', 'POST /v1/lenses/draft', 'POST /v1/lenses/preview', 'GET /v1/lenses/{id}/history', 'lensService.loadSharedLens', 'lensService.searchSharedLenses'], ['list_feed_lenses', 'get_feed_lens', 'draft_feed_lens', 'preview_feed_lens', 'get_feed_lens_history']),
  can('algorithm', 'My lenses: save, install, tune, history, revert, delete', ['GET /v1/me/lenses', 'POST /v1/me/lenses', 'POST /v1/me/lenses/install', 'POST /v1/me/lenses/{key}/tune', 'GET /v1/me/lenses/{key}/history', 'POST /v1/me/lenses/{key}/revert', 'DELETE /v1/me/lenses/{key}', 'lensService.loadMyLenses', 'lensService.saveMyLens', 'lensService.deleteMyLens', 'lensService.loadLensHistory', 'lensService.revertMyLens'], ['list_my_feed_lenses', 'save_feed_lens', 'install_feed_lens', 'tune_feed_lens', 'get_my_feed_lens_history', 'revert_feed_lens', 'delete_feed_lens']),
  can('algorithm', 'My feed interests', ['lensService.loadMyInterests', 'lensService.saveMyInterests'], ['get_feed_interests', 'set_feed_interests']),

  // Posting and interactions
  can('posting', 'Publish a post', ['POST /v1/me/posts', 'postService.publishPost'], ['publish_post']),
  cannot('posting', 'Attach a video to a post', ['POST /v1/me/media/videos', 'videoUpload.prepareVideo', 'videoUpload.discardPreparedVideo', 'videoUpload.uploadPostVideo', 'videoUpload.deletePostVideoFiles', 'videoFiles.readPickedVideo', 'videoFiles.probeVideo', 'videoFiles.previewUri', 'videoFiles.releasePreview', 'videoFiles.uploadBytes'], 'upload', 'A video is a file of up to hundreds of MB picked and cleaned of metadata on the device; MCP tool calls carry JSON. Scripts use POST /v1/me/media/videos.'),
  can('posting', 'Delete my post', ['DELETE /v1/me/posts/{id}', 'postService.deletePost'], ['delete_post']),
  can('posting', 'Report a post', ['POST /v1/posts/{id}/report', 'postService.reportPost'], ['report_post']),
  can('posting', 'Like, reshare and comment on Open Media posts', ['PUT /v1/me/posts/{id}/like', 'POST /v1/me/posts/{id}/like', 'DELETE /v1/me/posts/{id}/like', 'PUT /v1/me/posts/{id}/reshare', 'DELETE /v1/me/posts/{id}/reshare', 'GET /v1/me/posts/{id}/comments', 'POST /v1/me/posts/{id}/comments', 'GET /v1/posts/{id}/comments', 'interactionService.setPostLike', 'interactionService.setPostReshare', 'interactionService.addPostComment', 'interactionService.loadPostComments'], ['like_post', 'reshare_post', 'comment_on_post', 'get_post_comments']),
  can('posting', 'Like, reshare and comment on web-feed items', ['interactionService.setWebItemLike', 'interactionService.setWebItemReshare', 'interactionService.addWebItemComment', 'interactionService.loadWebItemComments', 'interactionService.loadWebItemEngagement'], ['like_web_item', 'reshare_web_item', 'comment_on_web_item', 'get_web_item_comments']),
  cannot('posting', 'Like, recast and reply on Farcaster, Lens, Hive and DeSo', ['interactionService.networkInteractionsDone', 'interactionService.interactOnNetwork', 'interactionService.canUndoOnNetwork', 'interactionService.undoOnNetwork', 'interactionService.loadNetworkReplies'], 'device-keys', 'Signed with the person’s network keys, which stay on their device (ADR 0007, 0039).'),
  can('posting', 'Cross-posting status', ['GET /v1/cross-posting/status'], ['cross_posting_status']),
  cannot('posting', 'Cross-post to other networks and remember defaults', ['crossPostService.publishingConnector', 'crossPostService.loadCrossPostPreferences', 'crossPostService.saveCrossPostPreferences', 'crossPostService.crossPost', 'crossPostService.rememberPublishedPost', 'crossPostService.removeCrossPostCopies', 'videoUpload.crossPostVideo', 'videoUpload.draftCrossPostVideo'], 'device-keys', 'Cross-posts are signed on the device with keys the person approved in each network; Open Media never holds them.'),

  // Listings, jobs, verification
  can('listings', 'Publish and edit listings and jobs', ['POST /v1/me/listings', 'PATCH /v1/me/listings/{postId}', 'postService.publishListing', 'postService.updateListing'], ['publish_listing', 'publish_job', 'update_listing']),
  can('listings', 'Rate a product or service', ['PUT /v1/me/listings/{postId}/rating', 'DELETE /v1/me/listings/{postId}/rating', 'postService.rateListing'], ['rate_listing']),
  can('listings', 'A listing’s checks and the transparency report', ['GET /v1/listings/{postId}/checks', 'GET /v1/transparency'], ['get_listing_checks', 'get_transparency']),
  can('listings', 'Verify listings as a verifier, and review as an operator', ['GET /v1/verification-tasks/next', 'POST /v1/verification-tasks/{taskId}', 'GET /v1/me/verifier', 'GET /v1/operator/review-queue', 'POST /v1/operator/posts/{postId}/decision', 'POST /v1/operator/replies'], ['get_verification_task', 'submit_verification', 'my_verifier_record', 'review_queue', 'decide_listing', 'answer_appeal']),
  can('work', 'Find jobs, tailor a resume and draft an application', ['GET /v1/jobs', 'POST /v1/me/career/tailor', 'POST /v1/me/career/application'], ['find_jobs', 'tailor_resume', 'draft_job_application']),
  can('work', 'Preview a profile from a link', ['GET /v1/profile-preview'], ['preview_profile_from_url']),

  // Messages
  can('messages', 'Conversations: list, open, read and send', ['GET /v1/me/conversations', 'POST /v1/me/conversations', 'GET /v1/me/conversations/{id}/messages', 'POST /v1/me/conversations/{id}/messages', 'openMediaService.loadOpenMediaConversations', 'openMediaService.startDirectConversation', 'openMediaService.sendOpenMediaMessage', 'openMediaService.createClientId'], ['list_conversations', 'start_conversation', 'get_conversation_messages', 'send_message']),
  can('messages', 'Reply to a message and react with an emoji', ['openMediaService.setMessageReaction'], ['send_message', 'react_to_message']),
  can('messages', 'Mark a conversation read or unread', ['POST /v1/me/conversations/{id}/read', 'openMediaService.markConversationRead', 'openMediaService.markConversationUnread'], ['mark_conversation_read', 'mark_conversation_unread']),
  can('messages', 'Read receipts', ['PUT /v1/me/settings/read-receipts', 'openMediaService.loadShareReadReceipts', 'openMediaService.setShareReadReceipts'], ['set_read_receipts']),
  can('messages', 'Report a conversation', ['POST /v1/me/conversations/{id}/report', 'openMediaService.reportConversation'], ['report_conversation']),
  cannot('messages', 'Live message updates', ['POST /v1/me/realtime-token', 'openMediaService.subscribeToOpenMediaMessages', 'openMediaService.unsubscribeFromOpenMediaMessages'], 'internal', 'A realtime socket for the app; agents read with list_conversations and get_conversation_messages.'),
  cannot('messages', 'GIFs, stickers and recent emoji', ['messageMediaService.searchGifs', 'messageMediaService.loadMediaPreferences', 'messageMediaService.saveMediaPreferences', 'messageMediaService.withRecentEmoji'], 'device', 'Recent emoji live on the device, and a GIF is a picker choice the app encodes into the message; agents send text and emoji.'),

  // AI
  can('ai', 'Open Media AI chat: read, ask, clear', ['GET /v1/me/ai/messages', 'POST /v1/me/ai/messages', 'DELETE /v1/me/ai/messages', 'aiChatConnector.loadAiMessages', 'aiChatConnector.sendAiMessage'], ['get_ai_chat', 'ask_ai', 'clear_ai_chat']),
  can('ai', 'Which model answers, and removing a saved key', ['GET /v1/me/ai/keys', 'PUT /v1/me/ai/model', 'DELETE /v1/me/ai/keys/{provider}', 'aiChatConnector.loadAiKeys', 'aiChatConnector.removeAiKey', 'aiChatConnector.chooseAiModel'], ['get_ai_settings', 'choose_ai_model', 'remove_ai_key']),
  cannot('ai', 'Save an AI provider’s API key', ['PUT /v1/me/ai/keys/{provider}', 'aiChatConnector.saveAiKey'], 'secret', 'Keys are pasted by the person in Settings → Open Media AI; an agent never handles them (ADR 0028).'),
  cannot('ai', 'AI chat plumbing', ['aiChatConnector.aiChatHeaders', 'aiChatConnector.onAiChatChanged', 'aiChatConnector.notifyAiChatChanged'], 'internal', 'Request headers and change notifications inside the app.'),

  // Email
  can('email', 'Connect, list, sync, send from and remove mailboxes; read mail', ['GET /v1/mail-accounts', 'POST /v1/mail-accounts', 'DELETE /v1/mail-accounts/{id}', 'POST /v1/mail-accounts/{id}/sync', 'POST /v1/mail-accounts/{id}/send', 'GET /v1/me/email', 'mailApiConnector.connectMailAccount', 'mailApiConnector.listMailAccounts', 'mailApiConnector.disconnectMailAccount', 'mailApiConnector.syncMailAccount', 'mailApiConnector.followMailAccount', 'mailApiConnector.sendMail', 'mailApiConnector.listStoredMail'], ['list_mailboxes', 'connect_mailbox', 'remove_mailbox', 'sync_mailbox', 'send_email', 'list_email']),
  can('email', 'Mark email read or unread', ['mailApiConnector.markMailSeen', 'mailApiConnector.markMailUnseen'], ['mark_email_read']),
  cannot('email', 'Open an attachment', ['mailApiConnector.attachmentURL'], 'upload', 'Attachments are files served by short-lived signed links for the app to open; list_email reports how many each message has.'),
  cannot('email', 'Mail API plumbing', ['mailApiConnector.request', 'mailApiConnector.apiConfigured', 'mailApiConnector.getAPIURL'], 'internal', 'HTTP helpers the app uses to reach the mail server.'),

  // Chat networks
  can('chats', 'Chat networks: connect, cancel, disconnect, read and reply', ['GET /v1/bridges', 'GET /v1/bridges/conversations', 'POST /v1/bridges/rooms/{id}/messages', 'GET /v1/bridges/{network}/flows', 'POST /v1/bridges/{network}/login/start', 'POST /v1/bridges/{network}/login/step', 'POST /v1/bridges/{network}/login/cancel', 'POST /v1/bridges/{network}/logout', 'bridgesConnector.loadBridgeStatus', 'bridgesConnector.loadBridgeFlows', 'bridgesConnector.startBridgeLogin', 'bridgesConnector.continueBridgeLogin', 'bridgesConnector.cancelBridgeLogin', 'bridgesConnector.disconnectBridge', 'bridgesConnector.loadBridgedConversations', 'bridgesConnector.sendBridgedMessage'], ['list_chat_networks', 'list_bridged_chats', 'send_bridged_message', 'chat_network_sign_in_options', 'start_chat_network_sign_in', 'continue_chat_network_sign_in', 'cancel_chat_network_sign_in', 'disconnect_chat_network']),
  can('chats', 'Mark a bridged chat read or unread', ['bridgesConnector.markBridgedChatRead', 'bridgesConnector.markBridgedChatUnread'], ['mark_bridged_chat_read']),

  // Web feeds
  can('web feeds', 'Find, follow, read and move web feeds (RSS, Atom, JSON Feed, OPML)', ['GET /v1/web-feeds/preview', 'GET /v1/me/web-feeds', 'POST /v1/me/web-feeds', 'DELETE /v1/me/web-feeds', 'GET /v1/me/web-feeds/items', 'GET /v1/me/web-feeds/opml', 'POST /v1/me/web-feeds/opml', 'webFeedService.listWebFeeds', 'webFeedService.previewWebFeed', 'webFeedService.followWebFeed', 'webFeedService.unfollowWebFeed', 'webFeedService.loadWebFeedItems', 'webFeedService.loadWebFeedProfile', 'webFeedService.importOpmlFile', 'webFeedService.exportOpml'], ['preview_web_feed', 'list_web_feeds', 'follow_web_feed', 'unfollow_web_feed', 'get_web_feed_items', 'import_opml', 'export_opml']),
  cannot('web feeds', 'Refresh the Feed when follows change', ['webFeedService.onWebFeedsChanged'], 'internal', 'An in-app change notification.'),

  // Payments and selling
  can('payments', 'Payment setup, payouts and tips', ['GET /v1/me/payments/setup', 'POST /v1/me/payments/payouts', 'POST /v1/me/payments/payouts/refresh', 'PUT /v1/me/payments/tips', 'paymentsService.loadPaymentSetup', 'paymentsService.startPayouts', 'paymentsService.refreshPayouts', 'paymentsService.setTipsEnabled'], ['get_payment_setup', 'start_payout_setup', 'refresh_payout_setup', 'set_tips']),
  can('payments', 'Pay for a listing, tip, or unlock a paid post', ['GET /v1/me/listings/{postId}/payment-options', 'GET /v1/me/posts/{id}/payment-options', 'GET /v1/me/payments', 'POST /v1/me/payments', 'GET /v1/me/payments/{id}', 'POST /v1/me/payments/{id}/transaction', 'POST /v1/me/payments/{id}/check', 'paymentsService.loadPaymentOptions', 'paymentsService.loadPostPaymentOptions', 'paymentsService.loadMyPayments', 'paymentsService.payFor', 'paymentsService.submitTransaction', 'paymentsService.checkPayment'], ['get_payment_options', 'list_my_payments', 'start_payment', 'get_payment', 'submit_payment_transaction', 'check_payment']),
  can('payments', 'Paid posts', ['POST /v1/me/paid-posts', 'GET /v1/me/posts/{id}/paid', 'postService.publishPaidPost', 'paymentsService.loadPaidContent'], ['publish_paid_post', 'get_paid_post']),
  can('payments', 'Remove a wallet', ['DELETE /v1/me/wallets/{id}', 'paymentsService.removeWallet'], ['remove_wallet']),
  cannot('payments', 'Link a USDC wallet', ['POST /v1/me/wallets', 'paymentsService.linkWallet'], 'device-keys', 'Linking needs a signature from the person’s own wallet on their device.'),
  cannot('payments', 'Payment webhooks', ['POST /v1/verification/stripe/webhook', 'POST /v1/payments/stripe/webhook'], 'internal', 'Called by Stripe, not by a person.'),
  can('selling', 'ONDC store settings', ['GET /v1/me/ondc', 'PUT /v1/me/ondc', 'ondcService.loadOndcStore', 'ondcService.saveOndcStore'], ['get_ondc_store', 'set_ondc_store']),

  // Everything else
  can('events', 'Upcoming events', ['GET /v1/events/upcoming', 'eventsService.loadUpcomingEvents'], ['find_upcoming_events']),
  can('settings', 'Find a setting', ['GET /v1/settings'], ['find_setting']),
  can('about', 'About Open Media', ['GET /v1/about'], ['about_open_media']),
  can('translation', 'Translate public and private text', ['GET /v1/translate', 'POST /v1/translate', 'translationService.translateText'], ['translate_text', 'translate_private_text']),
  cannot('translation', 'Automatic translation preferences', ['translationService.translationPreferences', 'translationService.subscribeTranslationPreferences', 'translationService.setTranslationPreferences'], 'device', 'Stored on the device; agents translate on request with translate_text.'),
  cannot('dictation', 'Dictate into any text field', ['dictationService.dictationSupported', 'dictationService.startDictation'], 'device', 'Needs the device’s microphone; agents already work in text.'),
];

/** The `file` in `file.function` for a source path: src/data/videoFiles.web.ts → videoFiles. */
export function sourcePrefix(path: string): string {
  return path.split('/').pop()!.replace(/\.tsx?$/, '').replace(/\.(web|native)$/, '');
}
