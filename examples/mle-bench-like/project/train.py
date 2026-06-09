from pathlib import Path

import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split

from features import add_tabular_features


def load_data(root: Path) -> tuple[pd.DataFrame, pd.Series, pd.DataFrame]:
    train = pd.read_csv(root / "train.csv")
    test = pd.read_csv(root / "test.csv")
    target = train.pop("target")
    return train, target, test


def main() -> None:
    data_root = Path("input")
    train, target, test = load_data(data_root)
    train_features = add_tabular_features(train)
    test_features = add_tabular_features(test)
    train_features, valid_features, train_target, valid_target = train_test_split(
        train_features,
        target,
        test_size=0.2,
        random_state=7,
        stratify=target,
    )
    model = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.04, random_state=7)
    model.fit(train_features, train_target)
    score = roc_auc_score(valid_target, model.predict_proba(valid_features)[:, 1])
    predictions = model.predict_proba(test_features)[:, 1]
    pd.DataFrame({"id": test["id"], "target": predictions}).to_csv("submission.csv", index=False)
    print(f"validation_auc={score:.5f}")


if __name__ == "__main__":
    main()
