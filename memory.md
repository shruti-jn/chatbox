# Workspace Memory

## Bug-Fix Verification Standard

After fixing a bug, take a Bayesian approach and estimate the final probability that the user will find the functionality actually works when they try it.

If the honest probability is below 90%, the task is not done. Keep iterating on verification and testability until the probability reaches at least 90%.

Testability is a first-class requirement. Add or improve tests, logging, diagnostics, instrumentation, and refactors as needed to make correctness observable and verifiable.

When reporting completion for a bug fix:
- state the final probability estimate explicitly
- briefly explain the main evidence that moved the probability upward
- call out the biggest remaining sources of uncertainty
