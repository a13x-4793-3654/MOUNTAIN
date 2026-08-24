FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# 差し込み印刷の Word(.docx)/Excel(.xlsx) → PDF 変換に LibreOffice を使用。
# Writer=docx、Calc=xlsx の変換に必要（Calc が無いと xlsx は「source file could not be loaded」で失敗）。
# 日本語フォント(Noto CJK)も同梱しないと PDF 内の日本語が豆腐(□)になるため必須。
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-writer \
        libreoffice-calc \
        fonts-noto-cjk \
        postgresql-client \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
