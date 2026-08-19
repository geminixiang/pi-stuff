package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

const defaultTK = "43b47d07-4795-45d9-819a-9c71c72e4105"
const defaultBase = "https://cloud.tipo.gov.tw/S220/opdataapi/api"

var kindName = map[int]string{1: "發明", 2: "新型", 3: "設計"}
var prefixClass = map[byte]int{'I': 1, 'M': 2, 'D': 3}

var queryKeys = []string{
	"applclass", "patentno", "noticeno", "noticebdate", "noticeedate",
	"noticebvolisu", "noticeevolisu", "publishno", "publishbdate", "publishedate",
	"publishbvolisu", "publishevolisu", "applno", "applbdate", "appledate",
	"patentname", "ipcfull", "ipcsection", "ipcclass", "ipcsubclass",
	"ipcmaingroup", "ipcgroup", "locfull", "loclevel1", "loclevel2",
	"applnamec", "applnamee", "applcountry", "inventornamec", "inventornamee",
	"inventorcountry", "agentnamec", "chargeexpirbdate", "chargeexpiredate",
	"chargeexpiryear", "top", "skip", "orderby", "service",
}

var dateKeys = map[string]bool{
	"noticebdate": true, "noticeedate": true, "publishbdate": true, "publishedate": true,
	"applbdate": true, "appledate": true, "chargeexpirbdate": true, "chargeexpiredate": true,
}

var aliases = map[string]string{
	"class": "applclass", "appl": "applno", "applicant": "applnamec",
	"inventor": "inventornamec", "agent": "agentnamec", "name": "patentname",
}

type query map[string]string

type charge struct {
	AnnuityDate string `json:"annuity_date"`
	AnnuityBeg  any    `json:"annuity_beg"`
	AnnuityEnd  any    `json:"annuity_end"`
}

type record struct {
	Kind            string   `json:"kind"`
	PatentNo        string   `json:"patent_no"`
	ApplNo          string   `json:"appl_no"`
	Title           string   `json:"title"`
	TitleEN         string   `json:"title_en"`
	Filed           string   `json:"filed"`
	Published       string   `json:"published"`
	Granted         string   `json:"granted"`
	TermStart       string   `json:"term_start"`
	TermEnd         string   `json:"term_end"`
	Status          string   `json:"status"`
	ChargeExpirDate string   `json:"charge_expir_date"`
	ChargeExpirYear string   `json:"charge_expir_year"`
	Applicant       string   `json:"applicant"`
	Inventor        string   `json:"inventor"`
	Agent           string   `json:"agent"`
	IPC             []string `json:"ipc"`
	Annuity         []charge `json:"annuity"`
}

type result struct {
	Total     int      `json:"total"`
	Returned  int      `json:"returned"`
	Snapshot  string   `json:"snapshot"`
	Records   []record `json:"records"`
	Sources   []string `json:"sources"`
	HTTPCalls int      `json:"http_calls"`
}

func schemaFile() string {
	return filepath.Join(scriptDir(), "..", "references", "schema.json")
}

func scriptDir() string {
	_, file, _, ok := runtime.Caller(0)
	if ok {
		dir := filepath.Dir(file)
		if _, err := os.Stat(filepath.Join(dir, "..", "references", "schema.json")); err == nil {
			return dir
		}
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if _, err := os.Stat(filepath.Join(dir, "..", "references", "schema.json")); err == nil {
			return dir
		}
	}
	wd, _ := os.Getwd()
	return wd
}

func checkSchema() error {
	raw, err := os.ReadFile(schemaFile())
	if err != nil {
		return nil
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return err
	}
	defs, _ := doc["$defs"].(map[string]any)
	q, _ := defs["Query"].(map[string]any)
	props, _ := q["properties"].(map[string]any)
	have := map[string]bool{}
	for _, k := range queryKeys {
		have[k] = true
		if _, ok := props[k]; !ok {
			return fmt.Errorf("schema missing Query.%s", k)
		}
	}
	for k := range props {
		if !have[k] {
			return fmt.Errorf("script missing Query.%s", k)
		}
	}
	return nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func asDateParam(v string) (string, error) {
	var b strings.Builder
	for _, r := range v {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	digits := b.String()
	if len(digits) != 8 {
		return "", fmt.Errorf("date must be YYYYMMDD: %s", v)
	}
	return digits, nil
}

func inferClass(q query) int {
	if q["noticeno"] != "" {
		return 1
	}
	for _, key := range []string{"patentno", "publishno"} {
		raw := q[key]
		if raw != "" && !strings.Contains(raw, "|") {
			c, ok := prefixClass[raw[0]]
			if ok {
				return c
			}
		}
	}
	applno := q["applno"]
	if len(applno) >= 4 && !strings.Contains(applno, "|") {
		switch applno[3] {
		case '1', '2', '3':
			return int(applno[3] - '0')
		}
	}
	return 0
}

func classesFor(q query) []int {
	if v := q["applclass"]; v != "" {
		n, err := strconv.Atoi(v)
		if err == nil && n >= 1 && n <= 3 {
			return []int{n}
		}
	}
	if n := inferClass(q); n != 0 {
		return []int{n}
	}
	return []int{1, 2, 3}
}

func normalize(q query) (query, error) {
	out := query{}
	for k, v := range q {
		out[k] = v
	}
	if v := out["patentno"]; v != "" {
		out["patentno"] = strings.ToUpper(v)
	}
	if v := out["publishno"]; v != "" {
		out["publishno"] = strings.ToUpper(v)
	}
	for k := range dateKeys {
		if out[k] != "" {
			d, err := asDateParam(out[k])
			if err != nil {
				return nil, err
			}
			out[k] = d
		}
	}
	if out["top"] == "" {
		out["top"] = "25"
	}
	if out["skip"] == "" {
		out["skip"] = "0"
	}
	if out["orderby"] == "" {
		out["orderby"] = "appl-no"
	}
	if out["service"] == "" {
		if out["patentno"] != "" || out["applno"] != "" || out["publishno"] != "" {
			out["service"] = "both"
		} else {
			out["service"] = "rights"
		}
	}
	return out, nil
}

func encode(params url.Values) string {
	parts := make([]string, 0, len(params))
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		for _, v := range params[k] {
			parts = append(parts, url.QueryEscape(k)+"="+strings.ReplaceAll(url.QueryEscape(v), "%7C", "|"))
		}
	}
	return strings.Join(parts, "&")
}

func httpGet(path string, params url.Values) (map[string]any, string, error) {
	base := strings.TrimRight(getenv("TIPO_OPDATA_BASE", defaultBase), "/")
	full := base + "/" + path + "?" + encode(params)
	client := &http.Client{Timeout: 60 * time.Second}
	req, err := http.NewRequest(http.MethodGet, full, nil)
	if err != nil {
		return nil, full, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, full, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, full, err
	}
	if resp.StatusCode != 200 {
		return nil, full, fmt.Errorf("HTTP %d %s", resp.StatusCode, full)
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, full, err
	}
	return payload, full, nil
}

func endpointParams(q query, applclass int, annuity bool) url.Values {
	p := url.Values{}
	p.Set("format", "json")
	p.Set("tk", getenv("TIPO_OPDATA_TK", defaultTK))
	p.Set("applclass", strconv.Itoa(applclass))
	p.Set("top", q["top"])
	p.Set("skip", q["skip"])
	p.Set("orderby", q["orderby"])
	skip := map[string]bool{"applclass": true, "top": true, "skip": true, "orderby": true, "service": true}
	if !annuity {
		skip["chargeexpiryear"] = true
	}
	for _, k := range queryKeys {
		if skip[k] || q[k] == "" {
			continue
		}
		p.Set(k, q[k])
	}
	return p
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func asList(v any) []any {
	list, _ := v.([]any)
	return list
}

func asString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return fmt.Sprint(t)
	}
}

func nested(m map[string]any, keys ...string) map[string]any {
	cur := m
	for _, k := range keys {
		cur = asMap(cur[k])
		if cur == nil {
			return map[string]any{}
		}
	}
	return cur
}

func bundleItems(payload map[string]any, names ...string) (string, []map[string]any) {
	for _, name := range names {
		b := asMap(payload[name])
		if b == nil {
			continue
		}
		var items []map[string]any
		for _, row := range asList(b["patentcontent"]) {
			if m := asMap(row); m != nil {
				items = append(items, m)
			}
		}
		return asString(b["-create-date"]), items
	}
	return "", nil
}

func people(v any) string {
	var names []string
	for _, row := range asList(v) {
		m := asMap(row)
		name := asString(m["chinese-name"])
		if name == "" {
			name = asString(m["english-name"])
		}
		if name == "" {
			name = "?"
		}
		names = append(names, name)
	}
	return strings.Join(names, "；")
}

func parseDay(s string) (time.Time, bool) {
	t, err := time.Parse("2006/01/02", s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

func addMonths(t time.Time, months int) time.Time {
	return t.AddDate(0, months, 0)
}

func statusLine(right map[string]any) string {
	if v := asString(right["revoke-date"]); v != "" {
		return "撤銷 (" + v + ")"
	}
	if v := asString(right["cancel-date"]); v != "" {
		return "消滅/註銷 (" + v + ")"
	}
	expirStr := asString(right["charge-expir-date"])
	expir, ok := parseDay(expirStr)
	if !ok {
		return "年費狀態不明"
	}
	today := time.Now()
	year := asString(right["charge-expir-year"])
	if !today.After(expir.Add(24*time.Hour - time.Nanosecond)) {
		return fmt.Sprintf("存續（年費繳至 %s，第 %s 年）", expirStr, year)
	}
	grace := addMonths(expir, 6)
	if !today.After(grace.Add(24*time.Hour - time.Nanosecond)) {
		return fmt.Sprintf("逾期補繳期中（原到期 %s，補繳迄約 %s）", expirStr, grace.Format("2006-01-02"))
	}
	return fmt.Sprintf("已消滅（欠繳年費，繳至 %s，補繳期已過）", expirStr)
}

func fetch(q query) (result, error) {
	service := q["service"]
	wantRights := service == "both" || service == "rights"
	wantAnnuity := service == "both" || service == "annuity"
	out := result{Records: []record{}}
	annuityBy := map[string]map[string]any{}

	for _, class := range classesFor(q) {
		if wantAnnuity {
			payload, src, err := httpGet("PatentAnnuity", endpointParams(q, class, true))
			if err != nil {
				return out, err
			}
			out.Sources = append(out.Sources, src)
			_, rows := bundleItems(payload, "tw-patent-annuity")
			for _, row := range rows {
				key := asString(row["patent-no"])
				if key == "" {
					key = asString(row["appl-no"])
				}
				if key != "" {
					annuityBy[key] = row
				}
			}
		}
		if !wantRights {
			continue
		}
		payload, src, err := httpGet("PatentRights", endpointParams(q, class, false))
		if err != nil {
			return out, err
		}
		out.Sources = append(out.Sources, src)
		if asString(payload["status"]) != "ok" {
			return out, fmt.Errorf("%s", asString(payload["message"]))
		}
		if n, err := strconv.Atoi(asString(payload["total-count"])); err == nil {
			out.Total += n
		}
		snap, items := bundleItems(payload, "tw-patent-rightsM", "tw-patent-rightsI", "tw-patent-rightsD")
		if out.Snapshot == "" {
			out.Snapshot = snap
		}
		for _, item := range items {
			pub := nested(item, "publication-reference")
			app := nested(item, "application-reference")
			title := nested(item, "patent-title")
			right := nested(item, "patent-right")
			parties := nested(item, "parties")
			patentNo := asString(right["patent-no"])
			applNo := asString(app["appl-no"])
			paid := annuityBy[patentNo]
			if paid == nil {
				paid = annuityBy[applNo]
			}
			if paid == nil {
				paid = map[string]any{}
			}
			var ipc []string
			for _, row := range asList(item["classification-ipc"]) {
				if code := asString(asMap(row)["ipc-full"]); code != "" {
					ipc = append(ipc, code)
				}
			}
			var charges []charge
			for _, row := range asList(paid["charges"]) {
				m := asMap(row)
				charges = append(charges, charge{
					AnnuityDate: asString(m["annuity-date"]),
					AnnuityBeg:  m["annuity-beg"],
					AnnuityEnd:  m["annuity-end"],
				})
			}
			expir := asString(right["charge-expir-date"])
			if expir == "" {
				expir = asString(paid["charge-expir-date"])
			}
			year := asString(right["charge-expir-year"])
			if year == "" {
				year = asString(paid["charge-expir-year"])
			}
			out.Records = append(out.Records, record{
				Kind:            kindName[class],
				PatentNo:        patentNo,
				ApplNo:          applNo,
				Title:           asString(title["patent-name-chinese"]),
				TitleEN:         asString(title["patent-name-english"]),
				Filed:           asString(app["appl-date"]),
				Published:       asString(pub["publish-date"]),
				Granted:         asString(right["licence-date"]),
				TermStart:       asString(right["patent-bdate"]),
				TermEnd:         asString(right["patent-edate"]),
				Status:          statusLine(right),
				ChargeExpirDate: expir,
				ChargeExpirYear: year,
				Applicant:       people(parties["applicants"]),
				Inventor:        people(parties["inventors"]),
				Agent:           people(parties["agents"]),
				IPC:             ipc,
				Annuity:         charges,
			})
		}
	}
	if !wantRights && wantAnnuity {
		out.Total = len(annuityBy)
	}
	out.Returned = len(out.Records)
	out.HTTPCalls = len(out.Sources)
	return out, nil
}

func printText(res result) {
	fmt.Printf("total: %d  returned: %d  calls: %d\n", res.Total, res.Returned, res.HTTPCalls)
	if res.Snapshot != "" {
		fmt.Printf("snapshot: %s\n", res.Snapshot)
	}
	if len(res.Records) == 0 {
		fmt.Println("no records")
	}
	for i, rec := range res.Records {
		id := rec.PatentNo
		if id == "" {
			id = rec.ApplNo
		}
		fmt.Printf("\n=== %d. %s (%s) ===\n", i+1, id, rec.Kind)
		if rec.Title != "" {
			fmt.Printf("title: %s\n", rec.Title)
		}
		if rec.TitleEN != "" {
			fmt.Printf("title_en: %s\n", rec.TitleEN)
		}
		fmt.Printf("appl_no: %s  filed: %s\n", rec.ApplNo, rec.Filed)
		fmt.Printf("published: %s  granted: %s\n", rec.Published, rec.Granted)
		fmt.Printf("term: %s → %s\n", rec.TermStart, rec.TermEnd)
		fmt.Printf("status: %s\n", rec.Status)
		fmt.Printf("applicant: %s\n", rec.Applicant)
		fmt.Printf("inventor: %s\n", rec.Inventor)
		fmt.Printf("agent: %s\n", rec.Agent)
		if len(rec.IPC) > 0 {
			fmt.Printf("ipc: %s\n", strings.Join(rec.IPC, ", "))
		}
		if len(rec.Annuity) > 0 {
			var bits []string
			for _, c := range rec.Annuity {
				bits = append(bits, fmt.Sprintf("%s 年%s–%s", c.AnnuityDate, asString(c.AnnuityBeg), asString(c.AnnuityEnd)))
			}
			fmt.Printf("annuity: %s\n", strings.Join(bits, "; "))
		}
	}
	fmt.Println("\nsources:")
	for _, src := range res.Sources {
		fmt.Printf("- %s\n", src)
	}
	if res.Total > res.Returned {
		fmt.Printf("note: raise --top (max 5000) rather than paging; %d not fetched\n", res.Total-res.Returned)
	}
}

func join(existing, next string) string {
	if existing == "" {
		return next
	}
	if next == "" {
		return existing
	}
	return existing + "|" + next
}

func parseArgs(args []string) (query, bool, bool, error) {
	fs := flag.NewFlagSet("lookup", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	queryJSON := fs.String("query", "", "JSON Query object")
	asJSON := fs.Bool("json", false, "print Result JSON")
	showSchema := fs.Bool("schema", false, "print schema path")
	values := map[string]*string{}
	repeats := map[string]*[]string{}
	for _, k := range queryKeys {
		if k == "applclass" || k == "top" || k == "skip" || k == "orderby" || k == "service" {
			s := fs.String(k, "", k)
			values[k] = s
			continue
		}
		var list []string
		repeats[k] = &list
		fs.Func(k, k, func(v string) error {
			*repeats[k] = append(*repeats[k], v)
			return nil
		})
	}
	fs.Int("class", 0, "alias of applclass")
	var aliasHold = map[string]*[]string{}
	for alias, canonical := range aliases {
		if alias == "class" {
			continue
		}
		var list []string
		aliasHold[canonical] = &list
		canon := canonical
		fs.Func(alias, "alias of "+canonical, func(v string) error {
			*aliasHold[canon] = append(*aliasHold[canon], v)
			return nil
		})
	}

	if err := fs.Parse(args); err != nil {
		return nil, false, false, err
	}
	if *showSchema {
		fmt.Println(schemaFile())
		fmt.Println("Query keys:", strings.Join(queryKeys, ", "))
		os.Exit(0)
	}

	q := query{}
	if *queryJSON != "" {
		var loaded map[string]any
		if err := json.Unmarshal([]byte(*queryJSON), &loaded); err != nil {
			return nil, false, false, fmt.Errorf("invalid --query JSON: %w", err)
		}
		allowed := map[string]bool{}
		for _, k := range queryKeys {
			allowed[k] = true
		}
		for k, v := range loaded {
			if !allowed[k] {
				return nil, false, false, fmt.Errorf("unknown Query key: %s", k)
			}
			q[k] = asString(v)
		}
	}
	classFlag := fs.Lookup("class")
	if classFlag != nil && classFlag.Value.String() != "0" {
		q["applclass"] = classFlag.Value.String()
	}
	for _, k := range []string{"applclass", "top", "skip", "orderby", "service"} {
		if values[k] != nil && *values[k] != "" {
			q[k] = *values[k]
		}
	}
	for k, list := range repeats {
		if list != nil && len(*list) > 0 {
			q[k] = join(q[k], strings.Join(*list, "|"))
		}
	}
	for canonical, list := range aliasHold {
		if list != nil && len(*list) > 0 {
			q[canonical] = join(q[canonical], strings.Join(*list, "|"))
		}
	}
	rest := fs.Args()
	if len(rest) > 1 {
		return nil, false, false, fmt.Errorf("unexpected extra arguments")
	}
	if len(rest) == 1 {
		q["patentno"] = join(q["patentno"], rest[0])
	}
	hasFilter := false
	for _, k := range queryKeys {
		if k == "top" || k == "skip" || k == "orderby" || k == "service" || k == "applclass" {
			continue
		}
		if q[k] != "" {
			hasFilter = true
			break
		}
	}
	if !hasFilter {
		return nil, false, false, fmt.Errorf("need a certificate number or at least one filter")
	}
	return q, *asJSON, *showSchema, nil
}

func main() {
	if err := checkSchema(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	q, asJSON, _, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		fmt.Fprintln(os.Stderr, "usage: lookup [--query JSON] [M000000] [--applclass 2] [--applicant 申請人]")
		os.Exit(2)
	}
	q, err = normalize(q)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	res, err := fetch(q)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		_ = enc.Encode(res)
		return
	}
	printText(res)
}
