# oracle-mcp

MCP-Server in TypeScript für lokale Oracle-Datenbanken (21c XE, auch 19c), gebaut für die Gemini CLI.
52 Tools: SQL und PL/SQL ausführen, Schemas und Objekte abfragen, Benutzer und Rechte verwalten,
Speicher analysieren und freigeben, Sessions und Parameter überwachen. Der vollständige Katalog steht in [tools.md](tools.md).

Der Login entspricht `sqlplus sys@localhost:1521/XEPDB1 as sysdba`. Es wird kein Oracle Client benötigt
(`node-oracledb` im Thin-Modus).

## Einrichten

```bash
npm install     # installiert die Abhängigkeiten und baut nach dist/
```

Danach den Block aus [gemini-settings.example.json](gemini-settings.example.json) in `~/.gemini/settings.json`
(oder `.gemini/settings.json` im Projekt) übernehmen und `cwd` anpassen.

Das Passwort kommt über `${ORACLE_PASSWORD}` aus der Umgebung, zum Beispiel:

```bash
export ORACLE_PASSWORD='dein-sys-passwort'
gemini
```

Alternativ das Passwort direkt in den `env`-Block schreiben. In Gemini zeigt `/mcp` den Server und seine Tools;
der erste sinnvolle Aufruf ist `oracle_connection_info`.

## Einstellungen (`env`-Block)

| Variable | Default | Bedeutung |
|---|---|---|
| `ORACLE_HOST` | `localhost` | Hostname |
| `ORACLE_PORT` | `1521` | Listener-Port |
| `ORACLE_SERVICE` | `XEPDB1` | Service-Name: `XEPDB1` für die PDB, `XE` für CDB-Root |
| `ORACLE_CONNECT_STRING` | – | kompletter Easy-Connect-String, überschreibt Host/Port/Service |
| `ORACLE_USER` | `sys` | Benutzer |
| `ORACLE_PASSWORD` | – (Pflicht) | Passwort |
| `ORACLE_PRIVILEGE` | `SYSDBA` bei `sys`, sonst leer | `SYSDBA`, `SYSOPER` oder leer |
| `ORACLE_READ_ONLY` | `false` | `true` bietet nur die 26 lesenden Tools an |
| `ORACLE_MAX_ROWS` | `200` | Obergrenze für Zeilen pro Antwort |
| `ORACLE_CALL_TIMEOUT_MS` | `60000` | Timeout pro Datenbank-Aufruf; Wartungs-Tools laufen ohne Timeout |
| `ORACLE_EXPORT_DIR` | `./exports` | Zielordner für `oracle_export_query` |

## Sicherheit

Die Session läuft als `SYS AS SYSDBA` und darf alles. Deshalb:

- Destruktive Tools (Drop, Truncate, Purge, Kill, Resize, `ALTER SYSTEM`) liefern ohne `confirm: true` nur eine
  Vorschau mit SQL und betroffenen Objekten.
- Oracle-eigene Schemas sind in den geführten Lösch-Tools gesperrt; über `oracle_execute` bleibt alles möglich.
- `"trust": false` in der Gemini-Konfiguration lassen, dann fragt Gemini vor jedem Tool-Call nach.

## Aufbau

```
src/index.ts          MCP-Server (stdio), Tool-Dispatch, Fehlerbehandlung
src/config.ts         Umgebungsvariablen
src/db.ts             eine dauerhafte Session, Query-Helfer, Reconnect
src/registry.ts       Tool-Format, flache JSON-Schemas für Gemini, Argument-Prüfung
src/util.ts           Bezeichner-Prüfung, SQL-Klassifizierung, Skript-Splitter
src/tools/*.ts        die 52 Tools in 8 Gruppen
```

Ein neues Tool ist ein weiterer Eintrag in einer der Listen unter `src/tools/`.
