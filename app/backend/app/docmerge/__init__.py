"""差し込み印刷（Word / Excel テンプレート → 差し込み → PDF）のコア。"""

from .core import (
    FIELD_CATALOG,
    catalog_as_list,
    parse_template_fields,
    fill_docx,
    RESTRICT_TYPES,
)
from .xlsx import parse_template_fields_xlsx, fill_xlsx
from .resolve import resolve_values
from .pdf import docx_to_pdf, xlsx_to_pdf

__all__ = [
    "FIELD_CATALOG",
    "catalog_as_list",
    "parse_template_fields",
    "fill_docx",
    "parse_template_fields_xlsx",
    "fill_xlsx",
    "RESTRICT_TYPES",
    "resolve_values",
    "docx_to_pdf",
    "xlsx_to_pdf",
]
