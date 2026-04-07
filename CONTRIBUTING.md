# Contributing to A2B

Thank you for your interest in A2B. Here's how to contribute.

## Getting Started

```bash
git clone https://github.com/TheAIuniversity/A2B.git
cd A2B
npm install
```

## Project Structure

```
packages/
  core/        # Trust engine, tiers, policy, registry
  ceo/         # CEO Agent supervisor
  onboarding/  # 7-phase pipeline + calibration
  adapters/    # Framework integrations
examples/
  basic/       # Minimal working example
```

## Development

- Write TypeScript, not JavaScript
- Keep functions small and well-typed
- Add JSDoc comments to public APIs
- Zero external dependencies in `@a2b/core`

## Pull Requests

1. Fork the repo
2. Create a branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Push and open a PR

## Areas We Need Help

- **Adapters**: LangChain, CrewAI, AutoGen, LangGraph integrations
- **Storage**: PostgreSQL, Redis, MongoDB adapters
- **Dashboard**: Web UI for monitoring agents
- **Testing**: Unit tests, integration tests, stress tests
- **Documentation**: Guides, tutorials, examples

## Questions?

Open an issue or reach out at hello@theaiuniversity.com.
