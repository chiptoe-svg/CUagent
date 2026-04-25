---
name: add-email-account
description: Register an email mailbox for skills to operate on — reading, triage, drafting, bulk archive. NOT a channel; inbound emails will not wake the agent. For email-as-a-channel, use /add-gmail instead. Supports Google Workspace (Gmail), Microsoft 365 (Outlook/Exchange), and IMAP.
---

# Add Email Account

Register email accounts that other skills (`/email-archive`, `/email-triage`, etc.) can **operate on**. Each account has a provider type, credentials, and a verified connection.

> **This is for reading / triage / drafting — not a channel.**
>
> `/add-email-account` registers a mailbox that skills *act on*: batch-classifying old mail, summarizing the inbox, drafting replies you still send by hand. Incoming emails do **not** trigger the agent here.
>
> If you want emails to *wake the agent* — route inbound mail into a chat thread, reply via the agent, etc. — that's a channel. Use `/add-gmail` instead. You can have both: a mailbox registered for triage here AND the same address wired as a channel via `/add-gmail`.

## Detect Group

```bash
MAIN_FOLDER=$(sqlite3 store/nanoclaw.db "SELECT folder FROM registered_groups WHERE is_main = 1 LIMIT 1;" 2>/dev/null)
echo "MAIN_FOLDER=${MAIN_FOLDER:-unknown}"
```

If empty, ask:
> Which group folder should I configure email accounts for?

## Check Existing Accounts

```bash
test -f "groups/${MAIN_FOLDER}/email-accounts.yaml" && cat "groups/${MAIN_FOLDER}/email-accounts.yaml" || echo "NO_ACCOUNTS"
```

If accounts exist, show them:

> Registered email accounts:
> 1. gmail — Google Workspace (<user>@g.clemson.edu) ✓
> 2. outlook — Microsoft 365 (<user>@clemson.edu) ✓
>
> What would you like to do?
> - **Add** another account
> - **Remove** an existing account
> - **Test** an existing account
> - **Done**

If no accounts exist, proceed to add one.

## Add Account

### Step 1: Choose provider

> What type of email account?
>
> 1. **Google Workspace / Gmail (MCP)** — uses `workspace-mcp`, BYO OAuth client, structured MCP tools (recommended)
> 2. **Microsoft 365 / Outlook / Exchange** — uses MS365 MCP, OAuth authentication
> 3. **IMAP** — any standard mail server (iCloud, university, self-hosted)
> 4. **Google Workspace / Gmail (CLI, deprecated)** — legacy `gws` binary. Kept for backward compatibility with existing `type: gws` accounts. Don't pick this for new setups.

Use `AskUserQuestion` to get the choice.

### Step 2: Authenticate (provider-specific)

#### Type: `gws_mcp` (Google Workspace via workspace-mcp — recommended)

First-time setup requires a Google Cloud OAuth Desktop Client. If the user hasn't created one, link them to:
> https://console.cloud.google.com/apis/credentials → *Create Credentials* → *OAuth client ID* → *Desktop app*

Save the client ID and secret into `.env`:
```
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
```

Check if tokens already exist:
```bash
ls ~/.nanoclaw/.gws-mcp-tokens/*.json 2>/dev/null
```

If any `*.json` files exist, authentication is already set up. Extract the email from the filename (workspace-mcp names tokens `{sanitized_email}.json`) or parse one of the JSON files for the `email` field.

If no tokens exist:
> Google Workspace (MCP) needs authentication. Please run:
> ```
> ! npm run provider-login gws_mcp
> ```
> This runs `scripts/gws-mcp-login.sh` which launches `workspace-mcp`, triggers OAuth via a browser, and writes the token to `~/.nanoclaw/.gws-mcp-tokens/{your_email}.json`. Once complete, tell me to continue.

After auth, verify tokens exist:
```bash
ls ~/.nanoclaw/.gws-mcp-tokens/*.json
```

Extract the email from the filename (strip `.json`, un-sanitize if needed) or from the JSON content.

#### Type: `gws` (Google Workspace CLI — deprecated)

Legacy path. Use only if the user explicitly wants to keep an existing `type: gws` account working. New setups should use `gws_mcp` above.

Check if already authenticated:
```bash
GWS_CREDENTIAL_STORE=plaintext gws gmail users getProfile --format json 2>&1
```

If authenticated, extract the email address. If not:
> The legacy `gws` CLI needs auth. Run `! gws auth login`, then tell me to continue.

Verify tokens are in place for container mounting:
```bash
test -d ~/.nanoclaw/.gws-tokens || mkdir -p ~/.nanoclaw/.gws-tokens
cp ~/.config/gws/credentials.json ~/.nanoclaw/.gws-tokens/ 2>/dev/null
cp ~/.config/gws/client_secret.json ~/.nanoclaw/.gws-tokens/ 2>/dev/null
```

#### Type: `ms365` (Microsoft 365 / Outlook / Exchange)

Check if already authenticated:
```bash
test -f ~/.nanoclaw/.ms365-tokens/.token-cache.json && echo "MS365_OK" || echo "MS365_NOT_FOUND"
```

If not authenticated:
> Microsoft 365 needs authentication. Please run:
> ```
> ! npm run ms365-login
> ```
> This will open a browser for OAuth consent. Once complete, tell me to continue.

After auth, verify by checking the token file exists and ask the user for their email address:

> What email address is this account for? (e.g., user@clemson.edu)

#### MS365 Permission Discovery

Before login, determine exactly which API permissions the Azure app has been granted. This drives the `--enabled-tools` regex — requesting scopes for tools the tenant hasn't approved will fail the entire login.

**Ask the user to paste their granted permissions:**

> I need to know which Microsoft Graph permissions your Azure app has been granted.
>
> **To find them:**
> 1. Go to [Azure Portal → App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
> 2. Select your app (e.g., "GCassistant Office 365")
> 3. Click **API permissions** in the left sidebar
> 4. Copy/paste the permissions table — or just list the **Permission** and **Status** columns
>
> It looks something like:
> ```
> Permission              Type        Status
> Calendars.ReadWrite     Delegated   Granted for Contoso
> Mail.Read               Delegated   Granted for Contoso
> Mail.ReadWrite          Delegated   Granted for Contoso
> Mail.Send               Delegated   Not granted
> Tasks.ReadWrite         Delegated   Granted for Contoso
> User.Read               Delegated   Granted for Contoso
> ```
>
> Paste whatever you see — I'll parse it.

Use `AskUserQuestion` to collect the permissions list.

**Parse the permissions and build the tool config:**

From the pasted list, extract each permission name and its grant status. Map granted permissions to MS365 MCP tool capabilities:

| Granted Permission | Enables |
|---|---|
| `Mail.Read` | list-mail-messages, get-mail-message, list-mail-folders, get-mail-folder |
| `Mail.ReadWrite` | All Mail.Read tools + create-mail-folder, delete-mail-message, move-mail-message, update-mail-message, add-mail-attachment, create-draft-message |
| `Mail.Send` | send-mail (NOT available without this) |
| `Calendars.Read` | list-calendar-events, get-calendar-event, get-calendar-view, list-specific-calendar-events |
| `Calendars.ReadWrite` | All Calendars.Read tools + create-calendar-event, update-calendar-event, delete-calendar-event, accept/decline/tentatively-accept |
| `Tasks.Read` | list-todo-tasks, get-todo-task, list-todo-lists |
| `Tasks.ReadWrite` | All Tasks.Read tools + create-todo-task, update-todo-task, delete-todo-task |
| `Chat.Read` | list-chats, get-chat-message (Teams) |
| `Contacts.Read` | list-contacts, get-contact |
| `Files.Read` / `Files.ReadWrite` | list-files, get-file (OneDrive) |

**Build the `--enabled-tools` regex** from only the granted permissions. The regex controls which tools the MCP server exposes, which in turn determines which OAuth scopes it requests. Example for Mail.Read + Mail.ReadWrite + Calendars.ReadWrite + Tasks.ReadWrite:

```
^(list-mail-(?!rule)|get-mail-(?!box)|create-mail-(?!rule)|delete-mail-(?!rule)|move-mail|update-mail-(?!rule)|add-mail|create-draft|list-calendar|get-calendar|create-calendar|update-calendar|delete-calendar|accept-calendar|decline-calendar|tentatively-accept|list-specific|get-specific|create-specific|update-specific|delete-specific|get-calendar-view|list-todo|get-todo|create-todo|update-todo|delete-todo|list-planner|get-planner|create-planner|update-planner|list-plan-tasks)
```

The negative lookaheads (`(?!rule)`, `(?!box)`) exclude mail-rules and mailbox-settings tools, which require scopes that most tenants don't grant.

**Update `container/providers/ms365.json`** with the derived regex in both `mcp.args` and `auth.loginCommand`. Also update the `agentDocs` field to accurately describe what's available vs. not.

**Report to the user:**

> **MS365 Permissions configured:**
>
> ✓ Read email — `Mail.Read`
> ✓ Write/move email — `Mail.ReadWrite`
> ✗ Send email — `Mail.Send` (not granted by tenant)
> ✓ Read/write calendar — `Calendars.ReadWrite`
> ✓ Read/write tasks — `Tasks.ReadWrite`
>
> The `--enabled-tools` filter has been configured to match these permissions exactly.
> Only tools backed by granted permissions will be exposed to the agent.
>
> **To add permissions later:** Request them in Azure Portal → API permissions,
> get admin consent, then re-run `/add-email-account` to update the tool filter.

#### Type: `imap` (Standard IMAP)

Collect connection details via `AskUserQuestion`:

> IMAP server details:
> 1. **Email address** (e.g., user@icloud.com)
> 2. **IMAP server** (e.g., imap.mail.me.com)
> 3. **Port** (default: 993)
> 4. **Security** (SSL/TLS — default, or STARTTLS)
> 5. **Username** (usually the email address)
> 6. **App password** (NOT your regular password — generate one in your email provider's security settings)

For common providers, auto-fill server details:
- iCloud: `imap.mail.me.com:993`
- Yahoo: `imap.mail.yahoo.com:993`
- Fastmail: `imap.fastmail.com:993`
- ProtonMail: requires ProtonMail Bridge (`127.0.0.1:1143`)

Store credentials securely:
```bash
mkdir -p ~/.nanoclaw/.imap-tokens
cat > ~/.nanoclaw/.imap-tokens/${ACCOUNT_ID}.json << 'EOF'
{
  "host": "imap.mail.me.com",
  "port": 993,
  "security": "ssl",
  "username": "user@icloud.com",
  "password": "xxxx-xxxx-xxxx-xxxx"
}
EOF
chmod 600 ~/.nanoclaw/.imap-tokens/${ACCOUNT_ID}.json
```

**Note:** IMAP support requires an IMAP MCP server or CLI tool in the container. If one is not yet available, tell the user:
> IMAP accounts are registered but not yet operational — an IMAP tool needs to be added to the container. The `gws` and `ms365` providers are ready to use now.

### Step 3: Choose an account ID

Suggest a short ID based on the provider and email:
> I'll call this account `gmail` (or `outlook`, `icloud`, etc.). Want a different name?

The ID must be unique, lowercase, alphanumeric + hyphens.

### Step 4: Verify connection

Test that the account can list inbox messages.

**gws_mcp:**
```
Call mcp__gws_mcp__search_gmail_messages with query "in:inbox" and max_results 3.
```

**gws (deprecated):**
```bash
GWS_CREDENTIAL_STORE=plaintext gws gmail +triage --max 3 --format json
```

**ms365:**
```
Call mcp__ms365__list-mail-messages to get 3 recent messages.
```

**imap:** Skip verification for now if no IMAP tool is available.

Report:
> ✓ Connected to <user>@g.clemson.edu (Gmail)
> Found 3 recent messages — account is working.

### Step 5: Save account

Write or update `groups/${MAIN_FOLDER}/email-accounts.yaml`:

```yaml
# Registered email accounts
# Used by: /email-archive, /email-triage, and other email skills
# Provider types: gws_mcp (recommended), ms365, imap, gws (deprecated CLI)

accounts:
  - id: gmail
    type: gws_mcp
    address: <user>@g.clemson.edu
    enabled: true
    added: "2026-04-18"

  - id: outlook
    type: ms365
    address: <user>@clemson.edu
    enabled: true
    added: "2026-04-18"
```

If the file already exists, append the new account (don't overwrite existing entries).

### Step 6: Done

> Account `ACCOUNT_ID` registered (TYPE — ADDRESS).
>
> This account is now available to provider-aware skills and downstream workflows.
>
> Add another account? Or type **done** to finish.

If the user wants to add another, loop back to Step 1.

---

## Remove Account

If the user chose "Remove":

> Which account to remove?

List accounts with numbers. On selection, remove the entry from `email-accounts.yaml`. Don't delete credentials — just disable the account.

---

## Test Account

If the user chose "Test":

> Which account to test?

List accounts. Run the verification step (Step 4) for the selected account. Report success or failure.

For `ms365` accounts, also read the `--enabled-tools` regex from `container/providers/ms365.json` and report which tool categories are enabled vs. excluded. If tools are failing, ask the user to re-check their Azure Portal API permissions and re-run the permission discovery step.

---

## Provider Operations Reference

This is the canonical reference for email operations by provider type. Other provider-aware skills and downstream workflows should reference this.

### Type: `gws_mcp` (Google Workspace via workspace-mcp)

All operations are MCP tool calls. Tool names follow the Gmail API verbs under the `mcp__gws_mcp__` prefix. Exact signatures come from MCP discovery at runtime — the agent should list tools if uncertain.

| Operation | Tool (typical name) | Args |
|-----------|---------------------|------|
| List inbox | `mcp__gws_mcp__search_gmail_messages` | `query: "in:inbox"`, `max_results: N` |
| List with date filter | `mcp__gws_mcp__search_gmail_messages` | `query: "in:inbox before:YYYY/MM/DD"`, `max_results: N` |
| Read message | `mcp__gws_mcp__get_gmail_message` | `message_id: MSG_ID` |
| List labels | `mcp__gws_mcp__list_gmail_labels` | — |
| Create label | `mcp__gws_mcp__create_gmail_label` | `name: "NAME"` |
| Move (label + archive) | `mcp__gws_mcp__modify_gmail_message_labels` | `message_id: MSG_ID`, `add_labels: [LABEL_ID]`, `remove_labels: ["INBOX"]` |
| Batch move | `mcp__gws_mcp__batch_modify_gmail_messages` | `message_ids: [...]`, `add_labels: [LABEL_ID]`, `remove_labels: ["INBOX"]` |

### Type: `gws` (Google Workspace CLI — deprecated, use `gws_mcp` for new setups)

| Operation | Command |
|-----------|---------|
| List inbox | `GWS_CREDENTIAL_STORE=plaintext gws gmail +triage --query "in:inbox" --max N --format json` |
| List with date filter | `GWS_CREDENTIAL_STORE=plaintext gws gmail +triage --query "in:inbox before:YYYY/MM/DD" --max N --format json` |
| Read message | `GWS_CREDENTIAL_STORE=plaintext gws gmail +read --id MSG_ID --headers --format json` |
| List labels | `GWS_CREDENTIAL_STORE=plaintext gws gmail users labels list --format json` |
| Create label | `GWS_CREDENTIAL_STORE=plaintext gws gmail users labels create --json '{"name":"NAME","labelListVisibility":"labelShow","messageListVisibility":"show"}' --format json` |
| Move (label + archive) | `GWS_CREDENTIAL_STORE=plaintext gws gmail users messages modify --params '{"id":"MSG_ID"}' --json '{"addLabelIds":["LABEL_ID"],"removeLabelIds":["INBOX"]}'` |
| Batch move | `GWS_CREDENTIAL_STORE=plaintext gws gmail users messages batchModify --json '{"ids":["ID1","ID2"],"addLabelIds":["LABEL_ID"],"removeLabelIds":["INBOX"]}'` |

### Type: `ms365` (Microsoft 365)

| Operation | Tool |
|-----------|------|
| List inbox | `mcp__ms365__list-mail-messages` |
| Read message | `mcp__ms365__get-mail-message` with message ID |
| List folders | `mcp__ms365__list-mail-folders` |
| Create folder | `mcp__ms365__create-mail-folder` (parent before child for nested) |
| Move message | `mcp__ms365__move-mail-message` with message ID and destination folder ID |

### Type: `imap` (Standard IMAP)

| Operation | Status |
|-----------|--------|
| All operations | Pending — requires IMAP MCP server or CLI tool in container |

To add IMAP support: install an IMAP MCP server, register it in `container/agent-runner/src/shared.ts`, add tool names to `allowedTools`, and fill in this table.

### Adding a new provider

1. Add a type entry to this reference table
2. Add detection + auth flow in Step 2 above
3. Update the container skill's provider dispatch
4. No changes needed to classification, rules, or state logic in consuming skills
