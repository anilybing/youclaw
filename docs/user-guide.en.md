# XiaoJuClaw User Guide

> This Markdown file is a searchable maintenance reference, not the primary customer guide. The illustrated offline guide is `web/public/user-guide/index.html` and is available from the in-app User Guide entry.
>
> Applies to XiaoJuClaw 1.2.12  
> Editions: Windows installer, USB portable, and offline  
> Last updated: July 11, 2026

XiaoJuClaw is a local digital-staff platform for one-person businesses and small teams. It can assist with chat, content, knowledge retrieval, workflows, scheduled tasks, messaging channels, and virtual-code inventory. It does not replace human approval for payments, refunds, publishing, deletion, account security, or other high-risk actions.

If this is your first session, complete the 10-minute setup before configuring advanced features.

## 1. Ten-minute quick start

### Start the application

- Installer edition: open `XiaoJuClaw` from the desktop or Start menu.
- USB portable edition: extract or copy the whole delivery folder, then run `Start-XiaoJuClaw.bat`. You may also run `XiaoJuClaw\XiaoJuClaw.exe`.
- Offline edition: start it in the same way as the portable edition.

Do not run the app from inside a ZIP file or copy only one EXE. The portable package must keep `XiaoJuClaw`, `XiaoJuClawRuntime`, and `XiaoJuClaw-User-Guide`. `XiaoJuClawData` is created on first launch.

### Sign in or use offline mode

- Online edition: enter your mobile number or email address, request a verification code, and sign in.
- Activation code: after signing in, open “Activation & Devices” and activate the intended device.
- Offline edition: no cloud account is required.
- Cloud unavailable: the app can fall back to local mode. Local chat and knowledge features remain available, while cloud login, activation, and remote capability updates do not.

Verification codes, activation codes, and model API keys are different credentials.

### Configure one working model

1. Click the account area at the lower left.
2. Open Settings.
3. Select Models.
4. Choose an available built-in model or add a compatible custom model.
5. A custom model normally requires an endpoint, model ID, and API key.
6. Save, open Chat, and send: “Reply with: setup complete.”

HTTP 401 or 403 usually indicates an invalid key, endpoint, or account permission. HTTP 429 usually means rate limiting or insufficient provider balance.

### Add your business profile

1. Open Today’s Operations.
2. Enter the business name, offer, audience, channels, current goals, and constraints.
3. Save and select “Generate action brief.”

The profile is the factual basis for business recommendations. Missing facts should not be invented.

### Run your first task

1. Open Digital Staff.
2. Choose a task card that matches your immediate goal.
3. Provide real input and explicit constraints.
4. Run the task.
5. A card marked Workflow opens a run detail view with step-by-step status and output.

Start with a low-risk task such as rewriting an email, drafting product copy, or generating a daily action brief.

### Review before use

Verify numbers, dates, prices, links, legal claims, promises, and external facts. Always approve content before publishing, sending, paying, refunding, or deleting.

## 2. Delivery editions

### Windows installer

- Best for a fixed computer and long-term use.
- Starts from the desktop or Start menu.
- User data is stored separately from program files.
- Back up user data before reinstalling or uninstalling.

### USB portable

- Designed for trials and moving between Windows computers.
- Includes its required runtime tools.
- Program, runtime, and user data use separate folders.
- Never run the same USB data folder on two computers at once.
- If the USB drive is slow, copy the entire delivery folder to a local disk.

### Offline edition

- Does not connect to the XiaoJuClaw cloud.
- Cloud login, activation, remote capability delivery, and online updates are unavailable.
- Configured third-party models, search, media services, or messaging channels can still send data to those providers.
- Fully disconnected use requires a locally reachable model endpoint and no network tools.

### Windows security warnings

Early portable builds may display an unknown-publisher or SmartScreen warning. Use only an official delivery and verify the supplied version and SHA-256 hash. Do not run an unknown or mismatched file, and never disable Windows Defender just to launch XiaoJuClaw.

## 3. Accounts, activation, and credits

Online sign-in uses an account plus a time-limited verification code. Codes are rate-limited and repeated failures may require a waiting period.

If a code does not arrive:

1. Verify the address or mobile number.
2. Check spam and enterprise mail quarantine.
3. Wait for the resend countdown.
4. Check cloud connectivity.
5. Contact support with the time and a masked account identifier.

Activation unlocks the plan or online digital-staff entitlement associated with the code. Confirm the signed-in account, target device, plan, and expiry before activation.

Renewals, upgrades, and credit packs are different products. Use the entitlement and expiry shown in the app rather than an old screenshot.

A custom model key belongs to your model provider. Provider billing, retention, and rate limits are governed by that provider and are not funded by a XiaoJuClaw activation code.

## 4. Models, voice, and media

Open “Account area → Settings → Models.”

A custom model usually needs:

- A recognizable display name.
- A compatible API endpoint.
- The exact provider model ID.
- An API key.
- Optional parameters only when required by provider documentation.

Test a short message before running long documents or workflows.

Model selection tips:

- Routine chat and rewriting: prioritize speed and cost.
- Long documents and workflows: use a model with a larger context window and reliable tool calling.
- Image understanding: select a vision-capable model.
- Sensitive material: prefer a trusted local provider or a provider with an appropriate data policy.

Voice recognition, speech generation, image generation, and video generation are configured separately under “Settings → Voice & Media.” A working chat model does not imply that media generation is configured.

Media generation may be billed per request. Review copyright, likeness, trademark, and platform requirements before using generated assets.

API keys are stored in the local user-data directory and are not currently protected by an operating-system credential vault. Do not share the data folder or leave production keys on a public computer.

## 5. Today’s Operations

Today’s Operations is the daily home page for a one-person business.

Keep the business profile current:

- Product or service.
- Target customer.
- Primary channels.
- Current goal.
- Budget, inventory, time, staffing, and compliance constraints.

The dashboard may summarize local workflow status, enabled automations, failing tasks, open plans, and known model usage. Some providers do not return complete usage data, so the displayed cost is not a provider invoice.

“Generate action brief” uses the business profile and locally available operating facts. If a brief invents information, update the profile and request: “Use only the supplied profile and data. Mark anything uncertain as To confirm.”

## 6. Digital staff and task cards

Digital Staff organizes ready-to-run tasks by office, commerce, content, finance, HR, support, research, and other business areas.

For each task:

1. Choose the relevant category.
2. Open a task card.
3. Complete its input.
4. Review the assigned employee and instructions.
5. Run and inspect the result.

The task cannot know external orders, customers, prices, or policy unless you provide them through a form, attachment, knowledge base, or an authorized tool.

A Workflow card runs multiple visible steps. Failed runs can normally resume after the underlying model, network, input, inventory, or permission issue is fixed.

The Agents page manages digital employees, personas, models, and skills. For a custom employee:

1. Define one clear role and goal.
2. Use AI optimization to structure a short draft.
3. Review the suggested name and skills.
4. Choose a model or inherit the global model.
5. Test with non-sensitive data.

Avoid giving one general employee every responsibility. Use specialized employees for finance, deletion, fulfillment, or external publishing.

## 7. Chat effectively

A strong request includes:

1. Goal.
2. Business and audience context.
3. Source material or attachments.
4. Constraints, deadline, and prohibited actions.
5. Required output format.
6. Acceptance criteria.

Example:

> Summarize the attached meeting notes into Decisions, Owners, Deadlines, and Open Questions. Do not invent names or dates. Mark uncertain items as To confirm.

For work with three or more steps, ask the employee to create and update an execution plan. Require it to pause before payments, publishing, deletion, or login verification.

Attach files before describing the expected operation. Image understanding needs a vision model, and audio transcription needs a configured speech-recognition provider. Very large documents should be split or uploaded to Knowledge.

Use thumbs-up for useful results. For a poor result, use thumbs-down and explain the concrete defect. To store a durable fact, say “Remember: …”. When correcting a fact, provide the complete replacement.

Never store passwords, one-time codes, full payment-card numbers, or temporary secrets as long-term memory.

## 8. Knowledge

Knowledge stores manuals, policies, pricing notes, FAQs, and project files for source-grounded answers.

1. Open Knowledge.
2. Upload or drag in `txt`, `md`, `pdf`, or `docx` files.
3. Wait for parsing.
4. Search for a distinctive phrase to verify indexing.

Image-only scanned PDFs may not contain extractable text. Convert them with OCR before upload.

For grounded answers, request:

> Answer only from Knowledge and cite the sources. If the answer is absent, say that it was not found.

Remove obsolete documents or include dates and version numbers in filenames. Conflicting active versions can produce unstable answers.

## 9. Workflows

Workflows turn repeatable work into visible, recoverable steps.

To run one:

1. Open Workflows.
2. Choose a workflow.
3. Select Run.
4. Complete the required input.
5. Follow the run history and step output.

Typical states are running, succeeded, failed, and skipped. For a failed run, inspect the failed step, fix the cause, and select Resume. Completed steps are normally reused.

If the workflow definition changed after the run began, an old run may not be resumable. Start a new run instead.

Begin with a small real sample before a batch. Keep human approval for publishing, payment, refunds, deletion, and other external side effects.

## 10. Scheduled tasks

Scheduled tasks run a selected employee with a saved prompt and can deliver the result to a configured channel.

1. Open Scheduled Tasks.
2. Create a task.
3. Name it and choose an employee.
4. Write a complete prompt and output format.
5. Choose interval, daily/weekly/monthly, or one-time execution.
6. Optionally choose a delivery channel and conversation.
7. Save and enable the task.

Important:

- Scheduling runs locally; XiaoJuClaw must be running at the scheduled time.
- Sleep, shutdown, network loss, or provider failure can delay or fail a run.
- Attachments must be inside the employee’s permitted workspace.
- Test with a one-time task five minutes in the future before enabling a recurring schedule.
- Disable a repeatedly failing task to avoid repeated cost.

## 11. Messaging channels and browser

Configure Telegram, Feishu, QQ, WeCom, DingTalk, WeChat Official Account, or Personal WeChat under “Settings → Channels.” Provider credentials and callback requirements differ.

Before production:

1. Use a test account or test group.
2. Verify inbound messages.
3. Verify outbound text.
4. Verify media last.
5. Confirm who is allowed to trigger the employee.

Platform permission, rate-limit, and risk-control policies take precedence. Do not automate around CAPTCHA, two-factor authentication, or account-security checks.

Browser capabilities can open public pages or assist within an authorized browser profile. Initial login, QR scans, verification codes, and risk-control prompts must be completed manually. Page automation may break after a site redesign and is not a substitute for an official platform API.

## 12. Skills, memory, and floating notifications

Skills provide role-specific instructions or tools. Review source, permissions, and description before installing a third-party skill. Enable only what the employee needs and test with non-sensitive data.

An employee can inspect installed skills, discover recommended skills, and request approval before installing an allowed source.

Memory stores durable facts and recent notes. Correct or remove obsolete prices, contacts, and preferences. Employees have separate workspaces and do not automatically share every fact.

The desktop floating window can notify you when a long task completes. Selecting a notification returns to the related chat. A notification means the task completed, not that its output has been approved.

## 13. Card Vault and Xianyu assistant

Card Vault manages local virtual-product SKUs, secret inventory, and delivery records.

To prepare inventory:

1. Create an SKU with a stable code and name.
2. Import secrets, normally one per line.
3. Confirm the available count.
4. Test with disposable sample data.

Use the Xianyu support employee with a unique order reference and the correct SKU. Order-reference idempotency prevents the same order from receiving a different secret. Delivery records are masked by default.

Current boundary: this is local inventory plus assisted fulfillment, not unattended Xianyu store management.

- It does not automatically detect real Xianyu orders.
- It does not automatically read or send Xianyu chat messages.
- It does not bypass login or platform risk controls.
- The seller must verify order, SKU, and buyer status and send the delivery content.
- Refunds, disputes, physical logistics, and high-risk support remain manual.

When a secret is used to generate delivery content, it may enter the selected model’s processing context. Use a trusted provider and never expose complete secrets in screenshots or support logs.

## 14. Logs and diagnostics

Logs show employee, tool, task, and system activity.

Before contacting support, collect:

- XiaoJuClaw version.
- Installer, portable, or offline edition.
- Error time and employee.
- Reproduction steps.
- Error text or a masked screenshot.
- Relevant log time, category, and severity.

Never send `secrets.json`, an entire database, an entire user-data folder, API keys, one-time codes, login tokens, complete virtual-product secrets, or unredacted customer data.

## 15. Backup, restore, and update

Portable folder ownership:

- `XiaoJuClaw`: replaceable program files.
- `XiaoJuClawRuntime`: replaceable bundled tools.
- `XiaoJuClaw-User-Guide`: replaceable illustrated manual for full-package upgrades.
- `XiaoJuClawData`: database, settings, keys, chats, knowledge, tasks, and workspaces. Never overwrite or delete it during an update.

To back up safely:

1. Wait for active chats, workflows, and tasks to finish.
2. Exit XiaoJuClaw and the floating window.
3. Confirm that both XiaoJuClaw processes have stopped.
4. Portable edition: copy the entire `XiaoJuClawData` folder.
5. Installer edition: find the actual data path under “Settings → Environment,” then copy that entire folder.
6. Store the backup on another disk with a date and app version.

Do not copy only `XiaoJuClaw.db` while the app is running. SQLite can also be using `-wal` and `-shm` files.

To restore, exit the app, rename the current data folder, put the complete backup at the original path, and verify settings, chats, knowledge, tasks, and workspaces before deleting the old folder.

For a full portable-package upgrade, replace `XiaoJuClaw`, `XiaoJuClawRuntime`, and `XiaoJuClaw-User-Guide`, preserving `XiaoJuClawData`. For a legacy flat-layout upgrade, merge the new package and run `Migrate-Legacy-Layout.bat` once.

Use the in-app updater or official installer for installer upgrades. Direct downgrade may be incompatible with a newer database; prefer a later forward-fix release.

Do not let multiple computers live-sync the same active data folder. Exit the app and sync a backup copy instead.

## 16. Troubleshooting

### App does not start

- Confirm it was extracted and the portable folders are complete.
- Run `Start-XiaoJuClaw.bat`.
- Check disk space, read-only USB state, and antivirus quarantine.
- Restart Windows.
- Preserve the data folder and provide version, time, and logs to support.

### Startup never completes

Wait 30 seconds for a port-conflict or recovery message. Close duplicate XiaoJuClaw processes and retry. Do not open multiple instances on one data folder.

### Chat does not respond

Check the selected model, endpoint, model ID, key, provider balance, rate limits, network, and proxy. Logs commonly show 401, 403, 429, timeout, or unsupported-tool errors.

### Workflow appears stuck

Open run details and inspect the active step. Network delay, queueing, and provider throttling can extend runtime. Do not repeatedly click Run because that may create multiple billed runs.

### Scheduled task did not run

Confirm the app was running, the computer was awake, the task was enabled, and system time and time zone were correct. Test a one-time task five minutes ahead.

### Knowledge cannot find content

Confirm parsing completed and search for an exact distinctive phrase. Image-only PDFs require OCR first.

### Channel receives but cannot send

Check bot send permission, conversation ID, platform limits, file size, and media type. Test plain text before files.

### Data appears missing after a portable update

Stop creating new data. Check whether the original `XiaoJuClawData` folder still exists and whether the app was launched from another copy. Preserve the original drive and contact support; do not format it.

## 17. Security and compliance

Keep human approval for:

- Payments, refunds, transfers, invoices, and accounting entries.
- Product publishing, removal, repricing, inventory clearing, and bulk changes.
- Customer promises about price, compensation, timing, law, or after-sales service.
- Deleting files, knowledge, employees, workflows, inventory, or chats.
- Login verification, QR scans, one-time codes, and platform risk controls.
- Sending personal data, trade secrets, or complete virtual-product secrets.

Third-party models, search, media, and messaging services can receive task input. Send only the minimum necessary data and comply with customer authorization, privacy, copyright, and platform rules.

Do not use XiaoJuClaw for account farming, CAPTCHA bypass, multi-account risk-control evasion, unauthorized data collection, or other prohibited automation.

## 18. First-day acceptance checklist

- [ ] The app starts and shows the expected version.
- [ ] The edition is identified as installer, portable, or offline.
- [ ] Sign-in or offline mode is understood.
- [ ] A short model test succeeds.
- [ ] The real business profile is saved.
- [ ] One low-risk task card succeeds.
- [ ] One test knowledge document is searchable.
- [ ] One workflow runs and its steps are understood.
- [ ] A one-time task five minutes ahead is tested.
- [ ] Any configured channel is tested in a test conversation.
- [ ] Any Card Vault setup uses a test SKU and order first.
- [ ] Logs and this guide can be found.
- [ ] A full user-data backup is completed after exit.
- [ ] The user knows which actions require human approval.

Add production keys, real customer data, live channels, and batch tasks only after this checklist passes.

## 19. Support

Before requesting help, prepare the version, edition, error time, reproduction steps, masked screenshots, and relevant logs. Website: `https://www.xiaojuclaw.top`.

Never send API keys, verification codes, login tokens, full virtual-product secrets, or unredacted customer data through support chat or email.
