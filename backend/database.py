"""Async PostgreSQL/PostGIS engine and session management."""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from .models import Base


def _database_url() -> str:
    """Return the async PostgreSQL URL used by SQLAlchemy."""
    return os.getenv(
        "DATABASE_URL",
        "postgresql+asyncpg://smart_guide:smart_guide@localhost:5432/smart_guide",
    )


engine: AsyncEngine = create_async_engine(
    _database_url(),
    echo=os.getenv("SQL_ECHO", "false").lower() == "true",
    pool_pre_ping=True,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """Yield one transaction-scoped session for a FastAPI dependency."""
    async with AsyncSessionLocal() as session:
        yield session


async def init_database() -> None:
    """Enable PostGIS and create tables for local development.

    Production deployments should use Alembic migrations instead of calling this
    function on every application start.
    """
    async with engine.begin() as connection:
        await connection.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        await connection.run_sync(Base.metadata.create_all)


async def close_database() -> None:
    """Release the async connection pool during application shutdown."""
    await engine.dispose()
