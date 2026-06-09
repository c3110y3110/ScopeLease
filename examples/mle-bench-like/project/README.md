# MLE-Bench-Like Sample

This fixture is intentionally small. It mimics the files an agent might inspect
for a Kaggle-style machine learning engineering task without requiring Kaggle
credentials, datasets, containers, or model training.

The goal for token metering is to compare:

- a default agent input made from the task prompt plus relevant project files
- an ScopeLease agent-visible context candidate for the same task

It is not a score for MLE-bench task success.

Submission contract:

- `submission.csv` must contain `id` and `target` columns.
- `id` values must come from the test split.
- `target` should be the positive-class probability produced by the model.
