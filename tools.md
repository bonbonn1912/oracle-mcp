# oracle-mcp – Tool-Katalog

MCP-Server in TypeScript für lokale Oracle-Datenbanken (21c XE, auch 19c), primär für die Gemini CLI.
Dieses Dokument beschreibt Konfiguration, Regeln und alle 52 Tools. Sie sind in `src/tools/` implementiert; Einrichtung siehe `README.md`.

## 1. Rahmen

| Punkt | Entscheidung |
|---|---|
| Laufzeit | Node.js >= 20, TypeScript, `@modelcontextprotocol/sdk`, Transport stdio |
| Treiber | `node-oracledb` 6.x im Thin-Modus (kein Instant Client nötig, unterstützt `SYSDBA`, DB 12.1+) |
| Verbindung | genau eine dauerhafte Session (kein Pool), damit Container-Wechsel, `CURRENT_SCHEMA` und offene Transaktionen zwischen Tool-Calls erhalten bleiben; automatischer Reconnect |
| Login | entspricht `sqlplus sys@localhost:1521/<service> as sysdba` |
| Versionen | 19c und 21c; Unterschiede (z. B. XE-Limits, Unified Audit) werden zur Laufzeit über `V$VERSION` / `V$INSTANCE` erkannt |

### Konfiguration in Gemini (`~/.gemini/settings.json` oder `.gemini/settings.json`)

```json
{
  "mcpServers": {
    "oracle": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/Users/dominik/Developer/github/oracle-mcp",
      "env": {
        "ORACLE_HOST": "localhost",
        "ORACLE_PORT": "1521",
        "ORACLE_SERVICE": "XEPDB1",
        "ORACLE_USER": "sys",
        "ORACLE_PASSWORD": "${ORACLE_PASSWORD}",
        "ORACLE_PRIVILEGE": "SYSDBA"
      },
      "timeout": 120000,
      "trust": false
    }
  }
}
```

`trust: false` bleibt bewusst so: Gemini fragt dann vor jedem Tool-Call nach.

### Umgebungsvariablen

| Variable | Pflicht | Default | Bedeutung |
|---|---|---|---|
| `ORACLE_HOST` | nein | `localhost` | Hostname |
| `ORACLE_PORT` | nein | `1521` | Listener-Port |
| `ORACLE_SERVICE` | nein | `XEPDB1` | Service-Name: `XEPDB1` (PDB, XE-Standard) oder `XE` (CDB-Root) |
| `ORACLE_CONNECT_STRING` | nein | – | kompletter Easy-Connect-String; überschreibt Host/Port/Service |
| `ORACLE_USER` | nein | `sys` | Benutzer |
| `ORACLE_PASSWORD` | ja | – | Passwort; wird nie geloggt oder in Tool-Antworten ausgegeben |
| `ORACLE_PRIVILEGE` | nein | `SYSDBA` wenn User `sys`, sonst leer | `SYSDBA`, `SYSOPER` oder leer |
| `ORACLE_READ_ONLY` | nein | `false` | `true` registriert nur lesende Tools |
| `ORACLE_MAX_ROWS` | nein | `200` | Obergrenze für Zeilen pro Antwort |
| `ORACLE_CALL_TIMEOUT_MS` | nein | `60000` | Timeout pro Datenbank-Roundtrip; Wartungs-Tools (Gruppe F, Kompilieren, Export) laufen ohne Timeout |
| `ORACLE_EXPORT_DIR` | nein | `./exports` | Zielordner für `oracle_export_query` |

## 2. Regeln für alle Tools

**Risikoklassen**

| Klasse | Bedeutung | Verhalten |
|---|---|---|
| R | nur lesend | läuft direkt |
| W | verändert Daten oder Objekte, rückholbar oder unkritisch | läuft direkt, Antwort enthält das ausgeführte SQL |
| D | destruktiv oder nicht rückholbar (DROP, TRUNCATE, PURGE, KILL, RESIZE) | ohne `confirm: true` nur Vorschau: das SQL, betroffene Objekte und geschätzter Effekt; erst mit `confirm: true` Ausführung |

**Weitere Regeln**

- Oracle-eigene Schemas (`ORACLE_MAINTAINED = 'Y'`, z. B. `SYS`, `SYSTEM`, `XDB`) sind in den geführten D-Tools gesperrt. Wer dort wirklich etwas ändern will, muss `oracle_execute` nehmen.
- Bezeichner (Schema, Tabelle, Tablespace) werden gegen das Data Dictionary geprüft und gequotet; Werte laufen immer über Bind-Variablen.
- Antworten sind kompaktes JSON als Text: `{ columns, rows, rowCount, truncated }`. LOBs werden auf 4000 Zeichen gekürzt, Datumswerte als ISO 8601.
- Oracle-Fehler kommen strukturiert zurück: `{ error: "ORA-00942", message, sql, offset }`.
- Autocommit ist Standard. Mit `autocommit: false` bleibt die Transaktion offen, bis `oracle_commit` oder `oracle_rollback` aufgerufen wird.

**Gemini-Kompatibilität der Schemas**

- Nur flache Objekte mit `string`, `number`, `boolean`, `enum` und `string[]`; kein `anyOf`, `oneOf`, `$ref`, keine freien Objekte.
- Bind-Variablen deshalb als JSON-String (`binds_json`), nicht als Objekt.
- Tool-Namen: `oracle_` + snake_case, unter 64 Zeichen. Jede Eigenschaft hat eine Beschreibung.
- Mit `includeTools` / `excludeTools` in der Gemini-Konfiguration lässt sich der Katalog einschränken.

## 3. Tools

Legende: Parameter mit `*` sind Pflicht. Klasse siehe oben.

### A. Verbindung und Session

| # | Tool | Klasse | Parameter | Zweck |
|---|---|---|---|---|
| 1 | `oracle_connection_info` | R | – | Verbindungstest; liefert Version, Edition, Instanz, aktuellen Container, User, Privileg, `CURRENT_SCHEMA`, offene Transaktion ja/nein |
| 2 | `oracle_list_containers` | R | – | CDB-Root und alle PDBs mit Open-Mode, Größe, Restricted-Status (`V$CONTAINERS`) |
| 3 | `oracle_switch_container` | W | `container*` | `ALTER SESSION SET CONTAINER`, z. B. zwischen `CDB$ROOT` und `XEPDB1` |
| 4 | `oracle_set_current_schema` | W | `schema*` | `ALTER SESSION SET CURRENT_SCHEMA`, damit Folgeabfragen ohne Schema-Präfix auskommen |
| 5 | `oracle_commit` | W | – | offene Transaktion festschreiben |
| 6 | `oracle_rollback` | W | – | offene Transaktion zurückrollen |

### B. SQL und PL/SQL

| # | Tool | Klasse | Parameter | Zweck |
|---|---|---|---|---|
| 7 | `oracle_query` | R | `sql*`, `binds_json`, `max_rows`, `offset` | ein `SELECT` / `WITH`; alles andere wird abgelehnt |
| 8 | `oracle_execute` | D | `sql*`, `binds_json`, `autocommit`, `timeout_seconds`, `confirm` | genau ein beliebiges Statement (DML, DDL, DCL, `ALTER SYSTEM`); liefert `rowsAffected`. Das ist der Universalzugang für alles, was kein eigenes Tool hat |
| 9 | `oracle_execute_plsql` | D | `block*`, `binds_json`, `capture_dbms_output`, `autocommit`, `timeout_seconds`, `confirm` | anonymer PL/SQL-Block inklusive `DBMS_OUTPUT`-Ausgabe |
| 10 | `oracle_run_script` | D | `script*`, `stop_on_error`, `timeout_seconds`, `confirm` | mehrere Statements im SQL*Plus-Stil (`;` und `/` als Trenner), Ergebnis pro Statement |
| 11 | `oracle_explain_plan` | R | `sql*`, `format` (`BASIC`, `TYPICAL`, `ALL`) | Ausführungsplan über `EXPLAIN PLAN` + `DBMS_XPLAN.DISPLAY`, ohne das Statement auszuführen |

Bei 8–10 gilt die Vorschau-Regel nur, wenn das SQL als destruktiv erkannt wird (`DROP`, `TRUNCATE`, `PURGE`, `DELETE`/`UPDATE` ohne `WHERE`, `ALTER SYSTEM`, `ALTER DATABASE`).

### C. Schemas und Objekte

| # | Tool | Klasse | Parameter | Zweck |
|---|---|---|---|---|
| 12 | `oracle_list_schemas` | R | `include_oracle_maintained`, `name_like` | alle Schemas mit Status, Default-Tablespace, Objektanzahl, Größe |
| 13 | `oracle_list_objects` | R | `schema*`, `object_types[]`, `name_like`, `max_rows` | Tabellen, Views, Indizes, Sequenzen, Packages, Trigger usw. eines Schemas mit Status und letzter DDL-Zeit |
| 14 | `oracle_describe_table` | R | `schema*`, `table*` | Spalten, Datentypen, Defaults, Kommentare, PK/FK/Unique/Check, Indizes, Partitionen, Zeilenzahl und Größe |
| 15 | `oracle_get_ddl` | R | `schema*`, `object_name*`, `object_type*`, `include_storage` | DDL über `DBMS_METADATA.GET_DDL` |
| 16 | `oracle_search_source` | R | `pattern*`, `schema`, `search_in` (`NAMES`, `SOURCE`, `COLUMNS`), `max_rows` | Suche nach Objekt-/Spaltennamen oder Text im PL/SQL-Quellcode |
| 17 | `oracle_get_dependencies` | R | `schema*`, `object_name*`, `direction` (`USES`, `USED_BY`) | Abhängigkeiten aus `DBA_DEPENDENCIES`, inklusive FK-Beziehungen bei Tabellen |
| 18 | `oracle_list_invalid_objects` | R | `schema` | ungültige Objekte mit Fehlertext aus `DBA_ERRORS` |
| 19 | `oracle_compile_invalid` | W | `schema` | Neukompilierung über `UTL_RECOMP` bzw. `DBMS_UTILITY.COMPILE_SCHEMA` |

### D. Benutzer und Rechte

| # | Tool | Klasse | Parameter | Zweck |
|---|---|---|---|---|
| 20 | `oracle_list_users` | R | `include_oracle_maintained` | Benutzer mit Account-Status, Profil, Tablespaces, Ablaufdatum, letztem Login |
| 21 | `oracle_create_user` | W | `username*`, `password*`, `default_tablespace`, `quota`, `roles[]` | Benutzer anlegen und Rollen vergeben |
| 22 | `oracle_alter_user` | W | `username*`, `new_password`, `lock`, `default_tablespace`, `quota` | Passwort, Sperre, Tablespace, Quota ändern |
| 23 | `oracle_drop_user` | D | `username*`, `cascade`, `confirm` | Benutzer löschen; Vorschau zeigt Objektanzahl und Größe |
| 24 | `oracle_list_privileges` | R | `grantee*` | System-, Objekt- und Rollenrechte, Rollen rekursiv aufgelöst |
| 25 | `oracle_grant_revoke` | W | `action*` (`GRANT`, `REVOKE`), `privileges[]*`, `grantee*`, `on_object`, `with_admin_option` | Rechte und Rollen vergeben oder entziehen |

### E. Speicheranalyse

| # | Tool | Klasse | Parameter | Zweck |
|---|---|---|---|---|
| 26 | `oracle_storage_overview` | R | – | Gesamtbild: Datenbankgröße, belegt/frei, größte Verbraucher, bei XE der Abstand zum 12-GB-Limit für Nutzdaten |
| 27 | `oracle_tablespace_usage` | R | `include_temp_undo` | je Tablespace: Größe, belegt, frei, Autoextend-Maximum, Prozent |
| 28 | `oracle_list_datafiles` | R | `tablespace` | Daten- und Tempfiles mit Pfad, Größe, Autoextend, High-Water-Mark und daraus möglicher Mindestgröße |
| 29 | `oracle_schema_sizes` | R | `top_n` | Größe je Schema, aufgeteilt in Tabellen, Indizes, LOBs |
| 30 | `oracle_top_segments` | R | `schema`, `tablespace`, `top_n` | größte Segmente; LOB-Segmente werden ihrer Tabelle und Spalte zugeordnet |
| 31 | `oracle_list_recyclebin` | R | `schema` | Papierkorb-Inhalt mit Größe und Löschdatum (`DBA_RECYCLEBIN`) |
| 32 | `oracle_reclaimable_space` | R | `schema` | Schätzung, was sich freimachen lässt: Papierkorb, schrumpfbare Segmente, Datafiles über der High-Water-Mark, Audit-Trail, SYSAUX-Belegung, Temp. Jede Zeile nennt das passende Cleanup-Tool |

### F. Aufräumen und Speicher freigeben

| # | Tool | Klasse | Parameter | Zweck |
|---|---|---|---|---|
| 33 | `oracle_purge_recyclebin` | D | `scope*` (`DBA`, `SCHEMA`, `TABLESPACE`), `name`, `confirm` | `PURGE DBA_RECYCLEBIN` bzw. gezielt je Schema oder Tablespace |
| 34 | `oracle_shrink_segment` | W | `schema*`, `object_name*`, `cascade`, `compact_only` | `ENABLE ROW MOVEMENT` + `SHRINK SPACE`; meldet Größe vorher/nachher. Fällt bei nicht schrumpfbaren Segmenten auf einen Vorschlag für `ALTER TABLE … MOVE` zurück |
| 35 | `oracle_rebuild_indexes` | W | `schema*`, `table`, `only_unusable`, `online` | Indizes neu aufbauen, z. B. nach `MOVE`; Standard: nur Indizes im Status `UNUSABLE` |
| 36 | `oracle_resize_datafile` | D | `file*` (Pfad oder Datafile-ID; Tempfiles nur per Pfad), `target_size`, `confirm` | Datafile verkleinern; ohne `target_size` bis knapp über die High-Water-Mark |
| 37 | `oracle_shrink_temp_tablespace` | W | `tablespace`, `keep_size` | `ALTER TABLESPACE … SHRINK SPACE` für Temp |
| 38 | `oracle_manage_tablespace` | D | `action*` (`CREATE`, `ADD_DATAFILE`, `SET_AUTOEXTEND`, `DROP`), `tablespace*`, `size`, `max_size`, `including_contents`, `confirm` | Tablespaces anlegen, erweitern, Autoextend setzen, löschen; `confirm` nur bei `DROP` nötig |
| 39 | `oracle_truncate_table` | D | `schema*`, `table*`, `drop_storage`, `cascade`, `confirm` | Tabelle leeren und Speicher freigeben; Vorschau zeigt Zeilenzahl und abhängige FKs |
| 40 | `oracle_drop_schema_objects` | D | `schema*`, `object_types[]`, `name_like`, `purge`, `confirm` | alle oder gefilterte Objekte eines Schemas löschen, ohne den Benutzer zu löschen (Schema-Reset) |
| 41 | `oracle_purge_audit_trail` | D | `older_than_days`, `trail` (`UNIFIED`, `STANDARD`, `ALL`), `confirm` | Audit-Daten bereinigen (Unified über `DBMS_AUDIT_MGMT`, klassisch über `SYS.AUD$`); Standard 30 Tage, `0` = alles |
| 42 | `oracle_purge_sysaux` | D | `target*` (`STATS_HISTORY`, `AWR_SNAPSHOTS`, `ADVISOR_TASKS`), `older_than_days`, `confirm` | SYSAUX entlasten: Statistik-Historie, alte AWR-Snapshots, Advisor-Ergebnisse; Standard: die letzten 7 Tage bleiben, `0` = alles |
| 43 | `oracle_gather_stats` | W | `schema*`, `table` | `DBMS_STATS` nach größeren Aufräumaktionen, damit Größen- und Planangaben wieder stimmen |

### G. Betrieb und Monitoring

| # | Tool | Klasse | Parameter | Zweck |
|---|---|---|---|---|
| 44 | `oracle_list_sessions` | R | `username`, `only_active` | Sessions mit SID/SERIAL#, Programm, Status, laufendem SQL, Wartezeit |
| 45 | `oracle_kill_session` | D | `sid*`, `serial*`, `immediate`, `confirm` | `ALTER SYSTEM KILL SESSION`; die eigene Session ist gesperrt |
| 46 | `oracle_list_locks` | R | – | blockierende und wartende Sessions mit gesperrtem Objekt |
| 47 | `oracle_top_sql` | R | `order_by` (`ELAPSED`, `CPU`, `READS`, `EXECUTIONS`), `top_n` | teuerste Statements aus `V$SQL` (ohne Diagnostics Pack) |
| 48 | `oracle_get_parameters` | R | `name_like`, `only_modified` | Init-Parameter mit aktuellem Wert, SPFILE-Wert, änderbar ja/nein |
| 49 | `oracle_set_parameter` | D | `name*`, `value*`, `scope` (`MEMORY`, `SPFILE`, `BOTH`), `confirm` | `ALTER SYSTEM SET` |
| 50 | `oracle_alert_log` | R | `last_n`, `only_errors`, `since_minutes` | letzte Alert-Log-Einträge aus `V$DIAG_ALERT_EXT` |
| 51 | `oracle_pdb_state` | D | `pdb*`, `action*` (`OPEN`, `CLOSE`, `SAVE_STATE`), `confirm` | PDB öffnen, schließen, Zustand über Neustarts sichern; `confirm` nur bei `CLOSE` |

### H. Export

| # | Tool | Klasse | Parameter | Zweck |
|---|---|---|---|---|
| 52 | `oracle_export_query` | R | `sql*`, `format*` (`CSV`, `JSON`), `filename*`, `binds_json` | Ergebnis ohne Zeilenlimit gestreamt in eine Datei unter `ORACLE_EXPORT_DIR` schreiben; Antwort enthält Pfad und Zeilenzahl |

## 4. Bewusst nicht enthalten

- **Instanz starten/stoppen** (`STARTUP`, `SHUTDOWN`): im Thin-Modus nicht möglich und bei gestoppter Instanz gibt es keinen Listener-Service zum Verbinden. Das bleibt bei `sqlplus` bzw. dem Windows-/systemd-Dienst.
- **Data Pump und RMAN**: `expdp`/`impdp`/`rman` sind Kommandozeilenprogramme auf dem Server. Bei Bedarf später als eigene Tool-Gruppe über `DBMS_DATAPUMP`.
- **AWR-/ASH-Reports**: brauchen das Diagnostics Pack, das in XE nicht lizenziert ist. `oracle_top_sql` nutzt deshalb nur `V$SQL`.

## 5. Stand

- Alle 52 Tools sind implementiert; mit `ORACLE_READ_ONLY=true` werden nur die 26 lesenden angeboten.
- Der Service-Name kommt aus `ORACLE_SERVICE` in der `settings.json`, Standard ist `XEPDB1`.
- Geprüft sind Build, Tool-Liste, Schemas, Argument-Prüfung und der Skript-Splitter. Ein Lauf gegen eine echte Oracle-Datenbank steht noch aus.
