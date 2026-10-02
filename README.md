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

### Wichtig: Echtes Kennwort vs. Windows OS-Authentifizierung (NTS)

`oracle-mcp` nutzt `node-oracledb` im **Thin-Modus** (reines JavaScript). Dadurch wird kein Oracle Instant Client benötigt, allerdings wird **keine** Windows-Betriebssystem-Authentifizierung (NTS) unterstützt.

- **Unterschied zu SQL\*Plus:** Wenn du dich lokal unter Windows via `sqlplus sys@localhost:1521/XEPDB1 as sysdba` anmeldest, greift bei aktiviertem `SQLNET.AUTHENTICATION_SERVICES = (NTS)` die Windows-Gruppenzugehörigkeit (`ORA_DBA`). In SQL\*Plus wird die Passworteingabe dann ignoriert.
- **Fehler `ORA-01017: Benutzername/Kennwort ungültig`:** Der MCP-Server verbindet sich echt über das Netzwerk und prüft das Passwort gegen die Oracle-Kennwortdatei. Stimmt das Passwort in `settings.json` nicht mit dem tatsächlichen Datenbank-Kennwort überein (oder ist `SYS` im Root-Container gesperrt), schlägt der Login fehl.

**Lösung / Kennwort neu setzen:**
In einer Multitenant-Datenbank (z. B. Oracle 21c XE) muss `SYS` im Root-Container (`CDB$ROOT`) entsperrt und das Passwort mit `CONTAINER = ALL` gesetzt werden:

```sql
sqlplus / as sysdba
ALTER SESSION SET CONTAINER = CDB$ROOT;
ALTER USER sys ACCOUNT UNLOCK;
ALTER USER sys IDENTIFIED BY "dein-passwort" CONTAINER = ALL;
exit;
```
Danach das identische Passwort in `settings.json` (oder als Umgebungsvariable `ORACLE_PASSWORD`) eintragen.

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
