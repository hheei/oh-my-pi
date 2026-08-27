# omp-enhance

OMP enhancement extension. `%skill-name` references are one available feature.

Ported from [`@hheei/pi-dollar-skill`](https://github.com/hheei/hepi-mono/tree/main/packages/pi-dollar-skill) to the OMP public Extension API.

## Install

```bash
omp install @hheei/omp-enhance
```

Restart OMP after installation. Verify:

```bash
omp plugin list
omp plugin doctor
```

## Usage

Type `%` in the prompt to see loaded skills. Continue typing to filter, then select a suggestion with the normal editor completion key.

```text
Use %librarian to research this topic.
```

When submitted, a known `%skill-name` is replaced by that skill's `SKILL.md` path. This lets the model read the skill through the normal prompt. Unknown names remain unchanged. References inside words, such as `email%skill`, are not expanded.

The extension only processes interactive input and only skills reported by OMP. It does not modify model output or files.

## Settings

Open OMP plugin settings, or use CLI commands:

```bash
omp plugin config list @hheei/omp-enhance
omp plugin config set @hheei/omp-enhance enabled true
omp plugin config set @hheei/omp-enhance maxSuggestions 50
```

- `enabled`: enable or disable `%skill-name` completion and expansion; default `true`.
- `maxSuggestions`: maximum completion rows, from `1` to `50`; default `50`.

Project settings override global settings.

## Editor behavior

While a known reference is present, left/right movement and backspace/delete operate on the complete `%skill-name` token instead of splitting it. The extension restores any editor factory that was active before it was installed.
