# Dynamic Windows & Dynamic Island Desktop Integration

This workspace integrates with the **Dynamic Windows** desktop environment (Apple-style Dynamic Island & Dynamic Notch).
The `dynamic_windows` MCP server is installed and exposes the `dynamic_island_notify` and `dynamic_island_shelf_file` tools.

## Dynamic Island Live Progress Guidelines

Whenever working on tasks in this workspace:
1. **Start of Task**: Call `dynamic_island_notify` with `status: "running"` (or `"thinking"`) and a concise, user-friendly `phase` summarizing your plan (e.g. `phase: "Analyzing repository & planning changes"`).
2. **Major Actions & Tool Steps**: When executing multi-step workflows, call `dynamic_island_notify` to update the desktop status:
   - Command execution: `status: "running"`, `phase: "Running <command/test>"`, `tool: "run_command"`
   - File edits: `status: "running"`, `phase: "Modifying <filename>"`, `tool: "edit_file"`
   - Compiling/Packaging: `status: "running"`, `phase: "Compiling standalone setup"`, `progress: <percent>`
3. **User Questions**: When waiting for answers via `ask_question`, call `dynamic_island_notify` with `status: "waiting"`, `phase: "Waiting for user input"`.
4. **Task Completion**: Upon finishing your response, call `dynamic_island_notify` with `status: "done"`, `phase: "Task completed"`.
5. **Drop Shelf**: Never place build outputs, setups, or installers into the desktop drop zone. Only shelf files when explicitly requested by the user.
6. **Continuous GitHub Sync**: Push all updates, fixes, and features directly to GitHub (`git push origin main`) every time changes are made, even for minor updates. In user-facing documentation and README, never describe the project as being based on TwoCode.
7. **Automatic GitHub Releases**: Whenever a new version is created or the version is bumped, always build the standalone setup (`npm run build:setup`) and publish an official GitHub Release using `gh release create v<version> "installer_output/DynamicWindows-Setup-v<version>.exe" --title "Dynamic Windows v<version>" --notes "<notes>"`.
