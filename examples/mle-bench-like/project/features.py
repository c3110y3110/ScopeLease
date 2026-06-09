import pandas as pd


def add_tabular_features(frame: pd.DataFrame) -> pd.DataFrame:
    result = frame.copy()
    numeric = result.select_dtypes(include=["number"]).columns
    for name in numeric:
        result[f"{name}_missing"] = result[name].isna().astype("int8")
        result[f"{name}_filled"] = result[name].fillna(result[name].median())
    if "date" in result.columns:
        parsed = pd.to_datetime(result["date"], errors="coerce")
        result["date_month"] = parsed.dt.month.fillna(0).astype("int16")
        result["date_dayofweek"] = parsed.dt.dayofweek.fillna(0).astype("int16")
    return result
