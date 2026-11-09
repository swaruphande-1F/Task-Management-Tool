# QA Task Board — Firebase web app

The team task tracker for 1 Finance QA. People sign in with their company Google account.

- **Sign-in:** Google, limited to `@1finance.org.in` accounts
- **Data:** Cloud Firestore, updates live for everyone
- **Hosting:** Firebase Hosting (free Spark plan is enough)
- **Roles:** Admin, Member, or Disabled (no access)

## What's in the folder

```
qa-task-board/
├── public/
│   ├── index.html      Screens: login, board, dialogs
│   ├── styles.css      Styling (light + dark mode)
│   ├── app.js          App logic: auth, Firestore, views
│   └── config.js       Allowed domain + built-in admins  ← edit me
├── firestore.rules     Security rules (the real access control)  ← edit me
├── firestore.indexes.json
├── firebase.json       Hosting + rules config
└── .firebaserc         Your Firebase project ID  ← edit me
```

---

## Setup (about 15 minutes, one time)

### 1. Create the Firebase project
1. Go to https://console.firebase.google.com → **Add project** → name it, e.g. `qa-task-board-1finance`.
2. Google Analytics isn't needed, so you can turn it off.

### 2. Turn on Google sign-in
1. **Build → Authentication → Get started**.
2. **Sign-in method → Google → Enable**, choose a support email, then **Save**.
3. **Settings → Authorized domains**: `<project-id>.web.app` and `localhost` are already listed. If you add a custom domain later, add it here too.

### 3. Create the database
1. **Build → Firestore Database → Create database**.
2. Choose the **asia-south1 (Mumbai)** location.
3. Start in **production mode**. The rules in this folder replace the defaults when you deploy.

### 4. Add a web app
**Project settings (gear icon) → Your apps → Web (`</>`)** → register an app named `QA Task Board`. You don't need to copy the config: Firebase Hosting gives it to the app automatically.

### 5. Edit three files
- `.firebaserc`: replace `YOUR-FIREBASE-PROJECT-ID` with your project ID.
- `public/config.js`: set `ALLOWED_DOMAIN` and `ADMIN_EMAILS`.
- `firestore.rules`: put the **same** domain (in the regex `1finance[.]org[.]in`) and the **same** admin email list in `builtInAdmin()`.

### 6. Deploy
You need Node.js 18 or newer.

```bash
npm install -g firebase-tools
firebase login
cd qa-task-board
firebase deploy --only firestore:rules,hosting
```

Firebase prints your app URL, for example `https://qa-task-board-1finance.web.app`. Share that link with the team.

---

## How access works

| Who | Can do |
|---|---|
| Built-in admin (listed in `config.js` + `firestore.rules`) | Everything, always |
| **Admin** | Add, edit and move any task; delete **any** task; change people's roles in the **Team** tab |
| **Member** | Add, edit and move any task; delete only tasks **they created** |
| **Disabled** | Can sign in, but sees "Your account is disabled" and can't read anything |
| Non-company Google accounts | Blocked when they sign in, and blocked by the database rules |

- New people become Members automatically the first time they sign in.
- Admins change roles in **Team** (this tab only shows for admins).
- The Firestore rules enforce all of this on Google's servers. Even someone who edits the page code in their browser can't get around it.

## Using the app
- **Board:** drag cards between To Do, In Progress, In Review and Done.
- **This week:** open tasks grouped into Overdue, Today, Later this week and No due date.
- **Calendar:** tasks shown by due date, one month at a time.
- **All tasks:** a sortable table.
- **Filters:** search, type, owner, and My tasks.
- **New tasks** default to **today's date** and **you** as owner. Both can be changed.

## Making changes
- **Add a task type or status:** update the list in `public/app.js` (`TYPES` / `STATUSES`) **and** in `validTask()` in `firestore.rules`, then redeploy.
- **Local testing:** `firebase emulators:start`, then open http://localhost:5000.
- **Backups:** Firestore → Import/Export (needs the Blaze plan), or export the `tasks` collection on a schedule.

## Costs
The free Spark plan covers 50K reads, 20K writes and 1 GiB of storage per day, plus 10 GB/month of hosting transfer. A QA team of 5–20 people stays well within that.
