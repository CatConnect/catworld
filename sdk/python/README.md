# catworld-sdk

Cliente oficial Python para a API Catworld.

## Instalação

```bash
pip install catworld-sdk
```

## Uso

```python
from catworld import CatworldClient

with CatworldClient("https://seu-catworld.exemplo.com", "cw_live_...") as client:
    projects = client.projects()
    datasets = client.datasets()

    result = client.upload("dados.csv", dataset_id="...", mode="replace")
    print(result["status"], result["rowCount"])

    rows = client.query("SELECT TOP 10 * FROM [schema].[tabela]")
    print(rows["rows"])
```

## Métodos

- `projects()` / `datasets()` / `tables(dataset_id)` / `rows(table_id, limit=100)`
- `query(sql, timeout=30, limit=10000)`
- `upload(path, dataset_id, mode="replace", key_column=None, poll_interval=2)`

O token de API precisa de permissão `WRITE` (ou `ADMIN`) no escopo do dataset para usar `upload()`.
