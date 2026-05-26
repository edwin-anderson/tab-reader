# Workflow correction — please reconsider the design

I need to surface a workflow detail that I don't think you have, and which I believe invalidates the assumption behind your current recommendation.

## The missing context

**I close Claude Desktop frequently.** Specifically, I quit and relaunch it every time I install a new MCP server or edit `claude_desktop_config.json`, which is a routine activity for me — I tinker with MCP setups often. This is not a rare event in my workflow; it's something that happens regularly, often multiple times in a single afternoon.

I also use Claude Code in short-lived terminal sessions throughout the day, sometimes overlapping with periods when I'm restarting Claude Desktop.

## Why this matters for the design

The current plan (bridge + fail-fast) assumes that primary-process death is a rare event, and therefore a brief failover window (~1–6 seconds, possibly with one failed tool call) is an acceptable cost. That assumption breaks down for my workflow:

- Every time I quit Claude Desktop to reload its config, if Claude Desktop happens to be the primary (which it usually will be, since it's typically already running when I open a Code session), the bridge in Claude Code will lose its connection and have to recover.
- If I'm mid-call with tab-reader from Code at that moment, the call fails.
- Even if I'm not mid-call, the extension has to reconnect to the new primary, which means a few seconds of "extension not connected" state where tools won't work.

What I assumed was a rare edge case is actually a regular occurrence for me.

## What I'd like you to reconsider

Given this, I want you to revisit the design without anchoring on your previous recommendation. In particular, please weigh the **always-on background server** approach (e.g. a macOS LaunchAgent / launchd plist that owns `:17321` independently of either Claude app) more seriously than you did before.

The intuition: if the WebSocket server lives in a process whose lifecycle is decoupled from both Claude apps, then quitting and relaunching Claude Desktop becomes a non-event for tab-reader. Both Claude apps become pure clients. There is no "primary" to die, so there is no failover to design around.

I'm not telling you this is the answer — I want you to think it through yourself. The previous tradeoff analysis you did was on the assumption "primary death is rare." Redo the analysis with "primary death happens multiple times a day for this user" and see where you land.

## Things I'd like you to consider in your re-analysis

- The trade-offs you already identified for the daemon approach (extra install step, lifecycle management, upgrade story, resource cost when idle). Reweigh them honestly against my actual workflow, not the hypothetical one.
- Whether the install/upgrade story can be made smooth enough that the daemon's overhead is acceptable. (I'm happy to follow a couple of setup commands if they only happen once.)
- Whether a hybrid is possible — e.g. the same binary acts as either a "spawned by Claude" server or a "long-running daemon" depending on how it's invoked. Or whether keeping them as one design is cleaner.
- Whether there are options I haven't been told about that would suit my workflow better than either the bridge or the daemon.

## What I'd like you to do next

1. Re-read your own previous analysis and identify which conclusions were load-bearing on the "rare failover" assumption.
2. Do whatever additional research you need to do — don't assume the previous research is sufficient if your design space has shifted.
3. Propose a new approach, with the rejected alternatives explicitly named and the reasoning for each rejection written out.
4. Surface the proposal to me for sign-off before touching any source files.

As before: I don't want code or implementation details in the proposal. I want the design choice and the reasoning. The implementation is your job, but the architecture decision is mine to confirm.

Thanks.
