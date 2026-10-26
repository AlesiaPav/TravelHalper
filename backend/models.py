"""SQLAlchemy models for the Smart City Guide backend."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from geoalchemy2 import Geography
from sqlalchemy import Column, DateTime, ForeignKey, String, Table, Text, UniqueConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """Base class shared by all database models."""


place_categories = Table(
    "place_categories",
    Base.metadata,
    Column("place_id", ForeignKey("places.id", ondelete="CASCADE"), primary_key=True),
    Column("category_id", ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True),
)


class City(Base):
    """A city available for download and offline use."""

    __tablename__ = "cities"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    country_code: Mapped[str] = mapped_column(String(2), nullable=False)
    center: Mapped[Optional[str]] = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=False),
        nullable=True,
    )
    boundary: Mapped[Optional[str]] = mapped_column(
        Geography(geometry_type="MULTIPOLYGON", srid=4326, spatial_index=False),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    categories: Mapped[List["Category"]] = relationship(
        back_populates="city", cascade="all, delete-orphan"
    )
    places: Mapped[List["Place"]] = relationship(
        back_populates="city", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("name", "country_code", name="uq_cities_name_country"),
    )


class Category(Base):
    """A city-specific category/tag used for filtering and recommendations."""

    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    city_id: Mapped[int] = mapped_column(
        ForeignKey("cities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)

    city: Mapped[City] = relationship(back_populates="categories")
    places: Mapped[List["Place"]] = relationship(
        secondary=place_categories, back_populates="categories"
    )

    __table_args__ = (
        UniqueConstraint("city_id", "name", name="uq_categories_city_name"),
    )


class Place(Base):
    """A point of interest stored as a WGS84 geographic point."""

    __tablename__ = "places"

    id: Mapped[int] = mapped_column(primary_key=True)
    city_id: Mapped[int] = mapped_column(
        ForeignKey("cities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    osm_id: Mapped[Optional[int]] = mapped_column(nullable=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    photo_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    website_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    rating: Mapped[Optional[float]] = mapped_column(nullable=True)
    location: Mapped[str] = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    city: Mapped[City] = relationship(back_populates="places")
    categories: Mapped[List[Category]] = relationship(
        secondary=place_categories, back_populates="places"
    )

    __table_args__ = (
        UniqueConstraint("city_id", "osm_id", name="uq_places_city_osm_id"),
    )
