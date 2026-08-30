# Judy health is a slash command, not a model tool

`memory_health` stays out of the Tool Surface. It is an OMP slash command that probes Judy. The model should not spend a tool turn on livez. The Pi extension registered it as a tool; OMP does not copy that part of the Pi trio onto the tool table. First Tool Surface is therefore `memory_search` and `memory_save` only.
