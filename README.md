# oracle-mcp

MCP-Server in TypeScript für Oracle-Datenbanken (21c XE lokal, auch 19c und Datenbanken auf Servern), gebaut für die Gemini CLI.
54 Tools: SQL und PL/SQL ausführen, Schemas und Objekte abfragen, Benutzer und Rechte verwalten,
Speicher analysieren und freigeben, Sessions und Parameter überwachen. Der vollständige Katalog steht in [tools.md](tools.md).

Ein Server bedient mehrere Datenbanken: `local` ist die Standardverbindung mit vollen Rechten
(entspricht `sqlplus sys@localhost:1521/XEPDB1 as sysdba`), dazu beliebig viele benannte Server, standardmäßig nur lesbar.
Es wird kein Oracle Client benötigt (`node-oracledb` im Thin-Modus).

## Einrichten

```bash
npm install     # installiert die Abhängigkeiten und baut nach dist/
```

Danach gibt es drei Dateien:

| Datei | Ort | Inhalt |
|---|---|---|
| `settings.json` | `~/.gemini/` oder `.gemini/` im Projekt | startet den MCP-Server |
| `connections.json` | Projektordner, neben `dist/` | alle Datenbankverbindungen |
| `.env` | Projektordner, neben `dist/` | alle Passwörter |

`connections.json` und `.env` stehen in `.gitignore`. Vorlagen: `gemini-settings.example.json`,
`connections.example.json`, `.env.example`. Nach Änderungen an den Dateien den MCP-Server in Gemini neu starten
(`/mcp refresh` oder Gemini neu starten).

### 1. `settings.json`

```json
{
  "mcpServers": {
    "oracle": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/pfad/zu/oracle-mcp",
      "timeout": 120000,
      "trust": false
    }
  }
}
```

`cwd` ist der Projektordner. Ein `env`-Block ist nicht nötig.

### 2. `connections.json`

Beispiel mit der lokalen Datenbank und zwei Servern; weitere Server (`db3`, `db4`, ...) sind einfach weitere Einträge:

```json
{
  "connections": {
    "local": {
      "description": "Lokale Datenbank, volle Rechte",
      "host": "localhost",
      "port": 1521,
      "service": "XEPDB1",
      "user": "sys",
      "privilege": "SYSDBA",
      "readOnly": false
    },
    "db1": {
      "description": "Wofür diese Datenbank da ist",
      "host": "db1.example.com",
      "port": 1521,
      "service": "SERVICE1",
      "user": "benutzer1"
    },
    "db2": {
      "description": "Wofür diese Datenbank da ist",
      "host": "db2.example.com",
      "port": 1521,
      "service": "SERVICE2",
      "user": "benutzer2"
    }
  }
}
```

Der Name eines Eintrags (`db1`, `db2`, ...) ist frei wählbar und der Name, unter dem die KI die Verbindung anspricht:
Buchstaben, Ziffern, `-` und `_`, höchstens 40 Zeichen, Groß-/Kleinschreibung egal.

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `description` | nein | Beschreibung; daran erkennt die KI, welche Datenbank gemeint ist |
| `host`, `port`, `service` | ja (oder `connectString`) | Ziel; `port` ist standardmäßig 1521 |
| `connectString` | – | kompletter Easy-Connect-String statt Host/Port/Service, z. B. `db.example.com:1521/ORCLPDB1` |
| `user` | ja | Datenbankbenutzer |
| `passwordEnv` | nein | Name des Passwort-Eintrags in der `.env`, falls er vom Standard abweichen soll |
| `privilege` | nein | `SYSDBA` oder `SYSOPER`; Standard leer |
| `readOnly` | nein | Standard `true`: nur lesende Tools. `false` erlaubt auch Änderungen |
| `dictionary` | nein | `auto` (Standard), `dba` oder `all`, siehe [Server mit normalen Benutzern](#server-mit-normalen-benutzern) |
| `maxRows` | nein | eigene Obergrenze für Zeilen pro Antwort |

**Besonderheiten von `local`:** Der Eintrag ist optional und alle seine Felder auch. Was fehlt, hat diese
Standardwerte: `localhost`, `1521`, `XEPDB1`, Benutzer `sys` mit `SYSDBA`, `readOnly: false`. Ganz ohne
`connections.json` gibt es also nur `local` mit diesen Werten.

### 3. `.env`

```
ORACLE_PASSWORD=passwort-der-lokalen-datenbank
ORACLE_PASSWORD_DB1=...
ORACLE_PASSWORD_DB2=...
```

- `local` liest `ORACLE_PASSWORD`.
- Jeder Server liest `ORACLE_PASSWORD_<NAME>`: Name in Großbuchstaben, Bindestriche als Unterstrich
  (`db1` wird zu `ORACLE_PASSWORD_DB1`, `mein-server` zu `ORACLE_PASSWORD_MEIN_SERVER`).
- Mit `"passwordEnv": "MEIN_NAME"` im Eintrag liest die Verbindung stattdessen `MEIN_NAME`.

Fehlt ein Passwort, startet der Server trotzdem. Die betroffene Verbindung meldet beim ersten Zugriff,
welcher Eintrag in der `.env` fehlt.

### Prüfen

In Gemini zeigt `/mcp` den Server mit seinen Tools. `oracle_list_connections` listet die Verbindungen,
`oracle_connection_info` testet die aktive.

## Mit mehreren Datenbanken arbeiten

- `oracle_list_connections` zeigt alle Verbindungen mit Beschreibung, Ziel, Nur-Lese-Status, ob ein Passwort
  hinterlegt ist und welche aktiv ist.
- Beim Start ist `local` aktiv. `oracle_use_connection` macht eine andere Verbindung aktiv; sie gilt dann für alle
  folgenden Aufrufe. Die Verbindung wird vorher getestet, bei einem Fehler bleibt die bisherige aktiv.
- Sobald mehr als eine Verbindung konfiguriert ist, hat jedes Tool den optionalen Parameter `connection`.
  Damit geht ein einzelner Aufruf gezielt an eine Datenbank, ohne die aktive zu wechseln.
- Jede Antwort nennt im Feld `connection`, gegen welche Datenbank sie lief.
- Jede Verbindung hat ihre eigene Session. Container-Wechsel, `CURRENT_SCHEMA` und offene Transaktionen gelten
  nur für die jeweilige Verbindung.

In Gemini reicht dann zum Beispiel: „Zeig mir die Tabellen im Schema APP auf db2“ oder
„Vergleiche die Spalten von APP.KUNDEN zwischen db1 und db2“.

### Server mit normalen Benutzern

Auf Nur-Lese-Verbindungen (`readOnly: true`, Standard für Server) lehnt der MCP-Server schreibende Tools mit
`READ_ONLY` ab, und `oracle_query` nimmt nur `SELECT` an.

Mit `dictionary: auto` prüft der Server beim ersten Zugriff, ob der Benutzer die `DBA_*`-Views lesen darf.
Wenn nicht, nutzt er die `ALL_*`-Views. Die zeigen genau die Schemas und Objekte, auf die der Benutzer Rechte hat.

| | Tools |
|---|---|
| funktionieren immer | Verbindung prüfen, Abfragen, Ausführungsplan, Schemas und Objekte auflisten, Tabellen beschreiben, DDL, Suche, Abhängigkeiten, ungültige Objekte, Benutzerliste, eigene Rechte, Export |
| brauchen `SELECT_CATALOG_ROLE` oder `SELECT ANY DICTIONARY` | Speicheranalyse, Sessions, Sperren, Top-SQL, Parameter, Alert-Log, Container-Liste |

Ohne DBA-Sicht entfallen Größenangaben, `oracle_list_schemas` zeigt nur Schemas mit sichtbaren Objekten und
`oracle_list_privileges` nur die eigenen Rechte. Tools der zweiten Zeile antworten dann mit einer Fehlermeldung,
die das fehlende Recht nennt.

Der Nur-Lese-Modus ist eine Schranke im MCP-Server. Wirklich garantiert ist er erst, wenn der Datenbankbenutzer
selbst nur Leserechte hat.

## Einstellungen über Umgebungsvariablen

Alle Variablen sind optional und können im `env`-Block der `settings.json` oder in der `.env` stehen
(der `env`-Block hat Vorrang vor der `.env`).

Für alle Verbindungen:

| Variable | Default | Bedeutung |
|---|---|---|
| `ORACLE_DEFAULT_CONNECTION` | `local` | Verbindung, die beim Start aktiv ist |
| `ORACLE_CONNECTIONS_FILE` | `connections.json` | Datei mit den Verbindungen, relativ zum Projektordner |
| `ORACLE_READ_ONLY` | `false` | `true` macht alle Verbindungen nur lesbar, auch `local` |
| `ORACLE_MAX_ROWS` | `200` | Obergrenze für Zeilen pro Antwort |
| `ORACLE_CALL_TIMEOUT_MS` | `60000` | Timeout pro Datenbank-Aufruf; Wartungs-Tools laufen ohne Timeout |
| `ORACLE_EXPORT_DIR` | `./exports` | Zielordner für `oracle_export_query` |

Nur für `local`, als Alternative zum Eintrag in der `connections.json` (der Eintrag dort hat Vorrang):

| Variable | Default | Bedeutung |
|---|---|---|
| `ORACLE_HOST` | `localhost` | Hostname |
| `ORACLE_PORT` | `1521` | Listener-Port |
| `ORACLE_SERVICE` | `XEPDB1` | Service-Name: `XEPDB1` für die PDB, `XE` für CDB-Root |
| `ORACLE_CONNECT_STRING` | – | kompletter Easy-Connect-String, überschreibt Host/Port/Service |
| `ORACLE_USER` | `sys` | Benutzer |
| `ORACLE_PASSWORD` | – | Passwort |
| `ORACLE_PRIVILEGE` | `SYSDBA` bei `sys`, sonst leer | `SYSDBA`, `SYSOPER` oder leer |
| `ORACLE_DICTIONARY` | `auto` | `dba`, `all` oder `auto` |

## Wenn der Login scheitert (ORA-01017)

`SYS AS SYSDBA` über den Listener wird gegen die Passwortdatei geprüft. Stimmt das Passwort dort nicht,
schlägt der Login fehl, obwohl das Passwort eigentlich richtig ist. Dann das SYS-Passwort einmal im
Root-Container neu setzen (lokal mit `sqlplus / as sysdba` anmelden):

```sql
ALTER SESSION SET CONTAINER = CDB$ROOT;
ALTER USER sys IDENTIFIED BY "neues-passwort" CONTAINER = ALL;
```

## Sicherheit

Die lokale Session läuft als `SYS AS SYSDBA` und darf alles. Deshalb:

- Destruktive Tools (Drop, Truncate, Purge, Kill, Resize, `ALTER SYSTEM`) liefern ohne `confirm: true` nur eine
  Vorschau mit SQL und betroffenen Objekten.
- Oracle-eigene Schemas sind in den geführten Lösch-Tools gesperrt; über `oracle_execute` bleibt alles möglich.
- Server sind nur lesbar, solange ihr Eintrag nicht `"readOnly": false` setzt.
- `"trust": false` in der Gemini-Konfiguration lassen, dann fragt Gemini vor jedem Tool-Call nach.
- Passwörter stehen nur in der `.env` und erscheinen weder in Tool-Antworten noch im Log.

## Aufbau

```
src/index.ts          MCP-Server (stdio), Tool-Dispatch, Wahl der Verbindung, Fehlerbehandlung
src/config.ts         connections.json, .env, Umgebungsvariablen
src/db.ts             eine dauerhafte Session je Verbindung, Query-Helfer, Reconnect
src/registry.ts       Tool-Format, flache JSON-Schemas für Gemini, Argument-Prüfung
src/util.ts           Bezeichner-Prüfung, SQL-Klassifizierung, Skript-Splitter
src/tools/*.ts        die 54 Tools in 8 Gruppen
```

Ein neues Tool ist ein weiterer Eintrag in einer der Listen unter `src/tools/`.
