from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "infra" / "migrations"
SCHEMAS_DIR = REPO_ROOT / "packages" / "contracts" / "schemas"


class Settings(BaseSettings):
    """Loaded from the repo-root .env (shared with the TS apps) and the environment."""

    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgres://trading:trading@localhost:5435/trading"
    redis_url: str = "redis://localhost:6375"
    strategy_config: str = "config/strategies.yaml"
    binance_api_key: str = ""
    binance_api_secret: str = ""
    log_level: str = "info"

    @property
    def sqlalchemy_url(self) -> str:
        url = self.database_url
        if url.startswith("postgres://"):
            url = "postgresql+psycopg://" + url[len("postgres://"):]
        elif url.startswith("postgresql://"):
            url = "postgresql+psycopg://" + url[len("postgresql://"):]
        return url

    @property
    def strategy_config_path(self) -> Path:
        p = Path(self.strategy_config)
        return p if p.is_absolute() else REPO_ROOT / p


settings = Settings()
