# SP Team Studio

SP Team Studio is a React/Vite website with a public studio site and a Firebase-powered profile network.

This README is for **developers and the support team**. It documents the current project structure, user flows, important data, and the common places to check when helping a user.

---

## 1. What the Website Does

### Main website

The root website is the SP Team Studio marketing/portfolio site.

It contains:

- Hero section
- Philosophy
- Trust
- Services
- Methodology
- Impact
- Community
- Hosting
- Contact modal
- Footer

### Profile Network

The profile system allows users to:

- Create an account
- Create a public profile
- Edit their profile
- Add a profile photo URL
- Add website, public email and public phone
- Publish image/video posts
- Like and comment on posts
- Receive visitor messages
- Reply to messages
- Delete posts, comments, messages and replies
- Upgrade to Premium
- Request a portfolio
- Share their public profile

---

## 2. Tech Stack

- React 18
- TypeScript
- Vite 5
- Firebase Authentication
- Firebase Firestore
- Firebase Storage
- Paystack
- Vercel
- CSS

Install:

```bash
npm install
```

Development:

```bash
npm run dev
```

Production build:

```bash
npm run build
```

Preview production build:

```bash
npm run preview
```

---

## 3. Project Structure

```text
src/
├── App.tsx
├── main.tsx
│
├── components/
│   ├── AmbientField.tsx
│   ├── BootSequence.tsx
│   ├── Community.tsx
│   ├── ContactModal.tsx
│   ├── FinalCta.tsx
│   ├── FlowItem.tsx
│   ├── Footer.tsx
│   ├── Header.tsx
│   ├── Hero.tsx
│   ├── Hosting.tsx
│   ├── Impact.tsx
│   ├── Methodology.tsx
│   ├── Philosophy.tsx
│   ├── Reveal.tsx
│   ├── SectionHeading.tsx
│   ├── SectionPrompt.tsx
│   ├── Services.tsx
│   └── Trust.tsx
│
├── hooks/
│   ├── useCounter.ts
│   ├── useDecodeText.ts
│   ├── useMediaQuery.ts
│   ├── usePointerGlow.ts
│   ├── useReveal.ts
│   ├── useScrollProgress.ts
│   └── useTypewriterRotator.ts
│
├── firebase/
│   └── profileFirebase.ts
│
├── profile/
│   ├── ProfileNetwork.tsx
│   ├── crypto.ts
│   ├── profile.css
│   └── validators.ts
│
└── styles/
    └── index.css
```

### Where to work

| Task | File / folder |
|---|---|
| Main website sections | `src/components/` |
| Main website routing | `src/App.tsx` |
| Profile system | `src/profile/ProfileNetwork.tsx` |
| Profile validation | `src/profile/validators.ts` |
| Message encryption | `src/profile/crypto.ts` |
| Profile styling | `src/profile/profile.css` |
| Firebase setup | `src/firebase/profileFirebase.ts` |
| Global website styling | `src/styles/index.css` |
| Reusable UI behaviour | `src/hooks/` |
| Vercel routing | `vercel.json` |

---

## 4. Routes

The project uses simple pathname routing in `src/App.tsx`.

| URL | Purpose |
|---|---|
| `/` | Main SP Team Studio website |
| `/profiles` | Profile login / dashboard |
| `/profile/{username}` | Public profile |
| `/profile/{username}/ad` | Public portfolio page |

Example:

```text
/profile/john
/profile/john/ad
```

If a new route is added, update `useProfileRoute()` in `src/App.tsx`.

---

# 5. Profile User Flow

## New user

```text
/profiles
   ↓
Create account
   ↓
Email + password
   ↓
Create profile
   ↓
Choose username
   ↓
Public profile becomes available
```

## Existing user

```text
/profiles
   ↓
Log in
   ↓
Dashboard
   ├── Manage profile
   ├── Posts
   ├── Inbox
   └── Premium / Portfolio
```

## Public visitor

```text
/profile/{username}
   ├── View profile
   ├── View posts
   ├── Message owner
   └── Share profile
```

---

# 6. Profile Rules

Usernames are normalized to lowercase.

Valid username format:

```text
3–24 characters
letters: a-z
numbers: 0-9
underscore: _
```

Validation is implemented in:

```text
src/profile/validators.ts
```

A profile contains information such as:

```text
uid
username
displayName
bio
photoUrl
websiteUrl
email
phone
premium
updatedAt
```

### Editing behaviour

After the profile is created:

- Username is locked.
- Display name is locked.
- Existing optional contact fields are locked.
- Bio remains editable.
- Optional fields that were empty during setup can be filled later.

This behaviour is implemented in `Dashboard()` inside `ProfileNetwork.tsx`.

---

# 7. Posts

Posts are stored in:

```text
posts/{postId}
```

Important fields:

```text
ownerId
mediaUrl
mediaType
caption
createdAt
updatedAt
```

A user can have up to:

```text
100 posts
```

Posts can use:

- Uploaded images
- Uploaded videos
- HTTP/HTTPS media URLs

Supported video URL extensions include:

```text
mp4
webm
ogg
mov
```

Post functionality is mainly inside `ProfileNetwork.tsx`.

---

# 8. Likes and Comments

Post likes:

```text
posts/{postId}/likes/{uid}
```

Comments:

```text
posts/{postId}/comments/{commentId}
```

Comment likes:

```text
posts/{postId}/comments/{commentId}/likes/{uid}
```

Deleting a post also removes its likes and comments.

Deleting a comment also removes its likes.

---

# 9. Messaging

Conversations are stored as:

```text
conversations/{conversationId}
```

Messages:

```text
conversations/{conversationId}/messages/{messageId}
```

Replies:

```text
conversations/{conversationId}/messages/{messageId}/replies/{replyId}
```

The profile owner sees conversations in the dashboard Inbox.

A visitor can message a public profile without creating a normal public-facing profile first.

### Message limits

```text
Maximum messages loaded per conversation: 5
Message length: 10–50 characters
Maximum replies per message: 20
Reply length: 10–50 characters
```

Validation is in:

```text
src/profile/validators.ts
```

---

# 10. Message Encryption

Message encryption/decryption is implemented in:

```text
src/profile/crypto.ts
```

The profile UI uses this when sending and reading conversation messages.

If messages fail to display correctly, check:

1. Authentication state.
2. Firestore access.
3. Browser console errors.
4. Local browser/device data used by the crypto implementation.
5. Whether the issue occurs for one conversation or all conversations.

Do not delete conversation data as a first troubleshooting step.

---

# 11. Auto-Delete

Posts, comments, likes, conversations, messages and replies can be placed into a 24-hour auto-delete queue.

The queue is stored locally in the browser using:

```text
localStorage
```

Storage key:

```text
spts_ttl_queue
```

The deletion period is:

```text
24 hours
```

Important for support:

> Auto delete works when the user's device/browser is online and the application runs its cleanup sweep.

It is **not a server-side Firebase TTL job**.

If a user says something did not auto-delete, check whether they were online and whether the same browser/device still has its local queue.

---

# 12. Firebase

Firebase setup is in:

```text
src/firebase/profileFirebase.ts
```

Services currently used:

- Firebase Authentication
- Firestore
- Firebase Storage

The application uses the Firebase project configured in that file.

### Main Firestore collections

```text
users
profiles
posts
conversations
upgradeintents
adrequest
```

Nested collections include:

```text
posts/{postId}/likes
posts/{postId}/comments
posts/{postId}/comments/{commentId}/likes

conversations/{conversationId}/messages
conversations/{conversationId}/messages/{messageId}/replies
```

Portfolio data uses the existing `ad` document structure under profiles:

```text
profiles/{username}/ad/code
```

The UI calls this feature **Portfolio**.

---

# 13. Media Storage

Uploaded profile post media is stored in Firebase Storage.

Current upload path pattern:

```text
posts/{user.uid}/{timestamp}_{filename}
```

After upload, the app gets the Firebase download URL and stores that URL in the post document.

If uploads fail, check Firebase Storage access first.

---

# 14. Premium

Premium is handled through Paystack.

Payment page configuration is in:

```text
src/profile/ProfileNetwork.tsx
```

The current payment page is configured through:

```text
PAYSTACK_UPGRADE_URL
```

The application also creates an upgrade intent in Firestore and uses the payment return flow to confirm the upgrade.

### Support: paid but Premium is missing

Check in this order:

1. User is logged into the correct account.
2. Payment was actually completed.
3. User returned to the website after payment.
4. Upgrade intent exists and has not expired.
5. `profiles/{username}` has the expected Premium state.
6. Browser console has no Firebase errors.
7. Firestore request was not rejected.

Do not change the Premium field manually without confirming the payment.

---

# 15. Portfolio

Premium users can request a portfolio.

Public portfolio URL:

```text
/profile/{username}/ad
```

Portfolio request data is handled through the profile application and the `adrequest` collection.

Portfolio content is stored using the existing profile `ad` document structure.

The public portfolio is displayed separately from the normal profile page.

If a portfolio is not showing, check:

1. Username is correct.
2. User has Premium.
3. Portfolio document exists.
4. Portfolio content exists.
5. Portfolio date/window is active.
6. Firestore request is successful.
7. Browser console contains no loading/rendering errors.

---

# 16. Support Contact

Profile support opens WhatsApp through the support URL generated in:

```text
src/profile/ProfileNetwork.tsx
```

Configuration:

```text
SUPPORT_WHATSAPP
SUPPORT_COUNTRY_CODE
```

Users see **Contact support** rather than the number directly.

If the support number changes, update those values and test the generated WhatsApp link.

---

# 17. First-Line Support Guide

## User cannot log in

Check:

- Email is correct.
- Password is correct.
- User is using Login rather than Create account.
- Firebase Authentication is working.
- Browser console does not show Firebase errors.

The app uses Firebase email/password authentication.

---

## User cannot create a profile

Check:

- Username follows the required format.
- Username is not already in use.
- Display name is provided.
- User is authenticated.
- Firestore is reachable.
- Firestore permissions allow the write.

Common messages:

```text
Username already exists.
Username must be 3-24 letters, numbers or underscore.
Unable to save profile.
```

---

## Public profile says "Profile not found"

Check:

```text
/profile/{username}
```

Then check Firestore:

```text
profiles/{username}
```

Also check username casing. Usernames are stored/handled in lowercase.

---

## User cannot edit profile

Current behaviour is intentional:

- Username cannot be changed after setup.
- Display name cannot be changed after setup.
- Existing filled optional fields are locked.
- Bio can be edited.
- Optional fields that were initially empty can be filled once.

If this needs to change, modify the `Dashboard()` field-locking logic in `ProfileNetwork.tsx`.

---

## Post upload failed

Check:

1. User is logged in.
2. File/media is valid.
3. Firebase Storage is available.
4. Storage permissions allow the upload.
5. Download URL is generated successfully.
6. Firestore post creation succeeds.

The post limit is 100.

---

## Image/video does not display

Check:

- `mediaUrl`
- `mediaType`
- Firebase Storage download URL
- Browser Network tab
- Browser console

Videos are intentionally not autoplayed. The user must press play.

Only one post video is allowed to play at a time.

---

## User cannot comment or like

Check:

- User is logged in.
- Firestore permissions.
- Correct post ID.
- Browser console.

Likes and comments are stored as nested Firestore documents under the post.

---

## User cannot send a message

Check:

- Public profile exists.
- Visitor conversation can be created/read.
- Message is 10–50 characters.
- Firestore permissions.
- Browser console.
- Encryption/decryption errors.

---

## Inbox is empty

Check:

```text
conversations
```

The dashboard loads conversations where:

```text
profileOwnerId == current user's UID
```

If the visitor can see the conversation but the owner cannot, check the conversation document and `profileOwnerId` first.

---

## Messages disappeared

Check the 24-hour auto-delete system first.

The application intentionally deletes messages/replies after their local TTL expires.

Also check whether the user is viewing from a different browser/device.

---

## User says Premium was paid but not activated

Check:

```text
Paystack payment
↓
upgrade intent
↓
return URL
↓
profile Premium state
```

Do not immediately ask the user to pay again.

---

## Portfolio is missing

Check:

```text
/profile/{username}/ad
```

Then check the user's Premium status and the portfolio document under:

```text
profiles/{username}/ad
```

---

# 18. Common Firebase Errors

### `permission-denied`

Usually means the Firebase Security Rules rejected the request.

Check:

- Authentication state
- User UID
- Document ownership
- Firestore rules
- Storage rules

### `not-found`

Usually means the expected Firestore document does not exist.

### `already-exists`

Usually means a document/username already exists where the code expects a new one.

### `failed-precondition`

Often points to a Firestore query/index or database configuration issue.

Check the browser console for the full Firebase error and index URL if one is provided.

---

# 19. Developer Notes

## Main profile file

Most profile functionality currently lives in one large file:

```text
src/profile/ProfileNetwork.tsx
```

This includes:

- Authentication UI
- Dashboard
- Public profile
- Posts
- Comments
- Likes
- Messaging
- Replies
- Premium
- Portfolio
- Support
- Auto-delete
- Media viewer

When adding a major feature, consider extracting it into its own component/module rather than making this file larger.

## Global styling

Main website:

```text
src/styles/index.css
```

Profile system:

```text
src/profile/profile.css
```

Keep profile-specific styles in `profile.css` unless they are genuinely shared by the main website.

---

# 20. Deployment

The project is configured for Vercel.

```text
vercel.json
```

The configuration rewrites requests to `index.html`, which allows the profile URLs to work when opened directly.

After deployment, test direct navigation to:

```text
/
/profiles
/profile/{username}
/profile/{username}/ad
```

---

# 21. Production Checklist

Before releasing a change:

- [ ] `npm install`
- [ ] `npm run build`
- [ ] Main website loads
- [ ] Login works
- [ ] Account creation works
- [ ] Profile creation works
- [ ] Public profile works
- [ ] Profile editing works
- [ ] Post creation works
- [ ] Post deletion works
- [ ] Comments work
- [ ] Likes work
- [ ] Visitor messaging works
- [ ] Inbox works
- [ ] Message replies work
- [ ] Premium flow works
- [ ] Portfolio works
- [ ] WhatsApp support link works
- [ ] Mobile layout works
- [ ] No unexpected browser console errors

---

# 22. Quick Reference

```text
Main site
/

Profile dashboard
/profiles

Public profile
/profile/{username}

Portfolio
/profile/{username}/ad

Firebase config
src/firebase/profileFirebase.ts

Profile application
src/profile/ProfileNetwork.tsx

Validation
src/profile/validators.ts

Message crypto
src/profile/crypto.ts

Profile CSS
src/profile/profile.css

Global CSS
src/styles/index.css

Deployment
vercel.json
```
