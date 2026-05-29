# Slack Setup

## Create app from manifest

The easiest setup path is to create the Slack app from `slack-app-manifest.yml` in the project root:

1. Open <https://api.slack.com/apps>.
2. Click **Create New App**.
3. Choose **From an app manifest**.
4. Select your workspace.
5. Paste the contents of `slack-app-manifest.yml`.
6. Create the app and install it to the workspace.

After import, still create an app-level token manually:

- Slack app → **Basic Information** → **App-Level Tokens**
- Create token with `connections:write`
- Put it in `.env` as `SLACK_APP_TOKEN=xapp-...`

Then upload the app icon manually:

- Slack app → **Basic Information** → **Display Information**
- Upload `assets/slack-app-icon-512.png` as the app icon
- Save changes

Slack manifests do not embed local image files, so the icon must be uploaded through Slack's app configuration UI after the manifest import.

The manifest enables Socket Mode, App Home, the App Home Messages tab for bot DMs, interactivity, the `app_home_opened` event, and the bot scopes used by the app. Calendar scheduling actions use Slack interactivity; free-text scheduling preferences are submitted through modals, so message-history scopes are not required for the initial mirrored-DM implementation.

## App features

Enable these Slack app features if you are configuring manually:

- **Socket Mode**: enabled
- **App Home**: enabled
- **App Home Messages tab**: enabled, not read-only
- **Interactivity & Shortcuts**: enabled
- **Event Subscriptions**: enabled for `app_home_opened`

Socket Mode means the local Docker container connects to Slack over WebSocket. No public HTTPS callback URL is required.

## Tokens

Create:

- Bot token: `SLACK_BOT_TOKEN=xoxb-...`
- App-level token with `connections:write`: `SLACK_APP_TOKEN=xapp-...`

## Bot scopes

Recommended bot scopes:

- `app_mentions:read` (optional, useful for future diagnostics)
- `channels:read` for public channel lookup/membership
- `groups:read` for private channel lookup/membership
- `chat:write` to send DMs
- `im:write` to open DMs
- `users:read` to filter active human users
- `users:read.email` to derive verified invite email addresses for calendar-assisted scheduling

## Events

Subscribe to bot events:

- `app_home_opened`

## Coffee channel

1. Create or choose a Slack channel, e.g. `#random-coffee`.
2. Invite the bot to the channel.
3. Configure the app from App Home by selecting the coffee channel in the admin modal.

Only active human users in this channel and not opted out are eligible for matching.

## Admin users

Set admin Slack user IDs in `.env`:

```env
ADMIN_USER_IDS=U01234567,U089ABCDE
```

Admin authorization is re-checked on every admin action before settings are persisted.
