package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	defaults "efttoolbox/backend/internal/defaults"
	contracts "efttoolbox/contracts"
)

var itemModes = map[string]string{"pvp": "regular", "pve": "pve", "pvp-season": "pvp-season"}
var itemIntervals = []int{60, 120, 240, 480, 720}
var itemCategories = []string{
	"headsets", "headgear", "eyewear", "body-armor", "tactical-rigs", "backpacks", "ammo", "weapons",
	"weapon-parts-mods", "pistol-grips", "suppressors", "throwables", "storage-containers", "barter-items", "keys", "provisions",
}

type upstreamItem struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	ShortName          string   `json:"shortName"`
	BaseImageLink      string   `json:"baseImageLink"`
	HandbookCategories []string `json:"handbookCategories"`
	Types              []string `json:"types"`
	SellToTrader       []struct {
		Trader   string `json:"trader"`
		PriceRUB int    `json:"priceRUB"`
	} `json:"sellToTrader"`
	BuyFromTrader []struct {
		Trader         string `json:"trader"`
		PriceRUB       int    `json:"priceRUB"`
		MinTraderLevel int    `json:"minTraderLevel"`
		TaskUnlock     string `json:"taskUnlock"`
		Currency       string `json:"currency"`
		CurrencyItem   string `json:"currencyItem"`
		Price          int    `json:"price"`
	} `json:"buyFromTrader"`
	Avg24hPrice  *int `json:"avg24hPrice"`
	LastLowPrice *int `json:"lastLowPrice"`
	Low24hPrice  *int `json:"low24hPrice"`
}

type upstreamBarter struct {
	ID             string `json:"id"`
	Trader         string `json:"trader"`
	TaskUnlock     string `json:"taskUnlock"`
	MinTraderLevel int    `json:"minTraderLevel"`
	RequiredItems  []struct {
		Item  string  `json:"item"`
		Count float64 `json:"count"`
	} `json:"requiredItems"`
	OfferedItem struct {
		Item  string  `json:"item"`
		Count float64 `json:"count"`
	} `json:"offeredItem"`
}

type upstreamTrader struct {
	ID         string `json:"id"`
	Normalized string `json:"normalizedName"`
	ImageLink  string `json:"imageLink"`
}

type upstreamCategory struct {
	Name           string `json:"name"`
	NormalizedName string `json:"normalizedName"`
}

type upstreamItems struct {
	Items              map[string]upstreamItem     `json:"items"`
	HandbookCategories map[string]upstreamCategory `json:"handbookCategories"`
}

type upstreamTask struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Objectives []struct {
		Type  string   `json:"type"`
		Items []string `json:"items"`
		Count int      `json:"count"`
	} `json:"objectives"`
}

// Currencies traders and the flea settle in. An offer priced in one of them is a normal cash
// purchase even when upstream models it through requiredItems.
var moneyItems = map[string]bool{
	"5449016a4bdc2d6f028b456f": true, // roubles
	"5696686a4bdc2da3298b456a": true, // dollars
	"569668774bdc2da2298b4568": true, // euros
}

type upstreamTasks struct {
	Tasks map[string]upstreamTask `json:"tasks"`
}

// Upstream stores task names under "<id> name" keys next to objective and skill strings. Only the
// suffixed entries are task names, and they are already keyed the way the catalog looks them up.
func taskNamesFromJSON(names map[string]string) map[string]string {
	result := map[string]string{}
	for key, name := range names {
		if name != "" && strings.HasSuffix(key, " name") {
			result[key] = name
		}
	}
	return result
}

type manifestEntry struct {
	Source   string `json:"source"`
	File     string `json:"file"`
	SHA256   string `json:"sha256"`
	Previous []struct {
		File   string `json:"file"`
		SHA256 string `json:"sha256"`
	} `json:"previous,omitempty"`
}

type itemManifest struct {
	FetchedAt string          `json:"fetchedAt"`
	Sources   []manifestEntry `json:"sources"`
}

type itemsManager struct {
	ctx      context.Context
	store    *mapStore
	hub      *overlayHub
	client   *http.Client
	mu       sync.Mutex
	status   contracts.ItemsUpdateStatus
	cancel   context.CancelFunc
	settings contracts.ItemsSettings
}

func defaultItemsSettings() contracts.ItemsSettings {
	return defaults.ItemsSettings()
}

func (m *itemsManager) resetSettings() error {
	value := defaults.ItemsSettings()
	if err := m.store.files.Save(filepath.Join("user", "items-settings.json"), value); err != nil {
		return err
	}
	m.mu.Lock()
	m.settings = value
	m.mu.Unlock()
	return nil
}

func validItemsSettings(value contracts.ItemsSettings) bool {
	return value.SchemaVersion == contracts.ContractSchemaVersion && slices.Contains(itemIntervals, value.IntervalMinutes) &&
		slices.Contains(append([]string{""}, itemCategories...), value.Category) &&
		slices.Contains([]string{"id", "name", "traderPrice", "fleaPrice", "lowestPrice"}, value.Sort)
}

func newItemsManager(ctx context.Context, store *mapStore, hub *overlayHub) *itemsManager {
	m := &itemsManager{ctx: ctx, store: store, hub: hub, client: &http.Client{Timeout: 30 * time.Second}, settings: defaultItemsSettings()}
	if readJSON(filepath.Join(store.root, "user", "items-settings.json"), &m.settings) != nil || !validItemsSettings(m.settings) {
		m.settings = defaultItemsSettings()
	}
	go m.autoUpdateLoop()
	return m
}

func (m *itemsManager) mode() string {
	if repo := m.store.repository(); repo != nil {
		return repo.mode
	}
	return "pvp"
}

func (m *itemsManager) catalogPath(locale string) string {
	return m.catalogPathFor(m.mode(), locale)
}

func (m *itemsManager) catalogPathFor(mode, locale string) string {
	return filepath.Join(m.store.root, "upstream", "items", mode, "items_"+locale+".json")
}

func (m *itemsManager) readSettings() contracts.ItemsSettings {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.settings
}

func (m *itemsManager) statusCopy() contracts.ItemsUpdateStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

func (m *itemsManager) setStatus(update func(*contracts.ItemsUpdateStatus)) {
	m.mu.Lock()
	update(&m.status)
	m.mu.Unlock()
}

func (m *itemsManager) fetchJSON(ctx context.Context, mode, name string, value any) error {
	base := "https://json.tarkov.dev/" + itemModes[mode]
	endpoint, _ := url.JoinPath(base, name)
	var last error
	for _, delay := range []time.Duration{0, 2 * time.Second, 5 * time.Second} {
		if delay > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return err
		}
		response, err := m.client.Do(req)
		if err != nil {
			last = err
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 64<<20))
		_ = response.Body.Close()
		if readErr == nil && response.StatusCode >= 200 && response.StatusCode < 300 {
			var envelope struct {
				Data json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal(body, &envelope); err == nil {
				if err := json.Unmarshal(envelope.Data, value); err == nil {
					return nil
				}
			}
			last = errors.New("invalid upstream response")
		} else {
			last = fmt.Errorf("upstream returned %s", response.Status)
		}
	}
	return last
}

func bestSellOffer(item upstreamItem) *struct {
	Trader   string
	PriceRUB int
} {
	var best *struct {
		Trader   string
		PriceRUB int
	}
	for _, trader := range item.SellToTrader {
		if best == nil || trader.PriceRUB > best.PriceRUB {
			best = &struct {
				Trader   string
				PriceRUB int
			}{Trader: trader.Trader, PriceRUB: trader.PriceRUB}
		}
	}
	return best
}

func itemCatalog(mode string, source upstreamItems, traders map[string]upstreamTrader, zh, en map[string]string, images map[string]string, locale string, taskNames map[string]string, tasks upstreamTasks, barters []upstreamBarter) contracts.ItemsCatalog {
	items := make([]contracts.ItemsCatalogItem, 0, len(source.Items))
	bartersByReward := map[string][]upstreamBarter{}
	for _, barter := range barters {
		if barter.OfferedItem.Item != "" {
			bartersByReward[barter.OfferedItem.Item] = append(bartersByReward[barter.OfferedItem.Item], barter)
		}
	}
	for _, item := range source.Items {
		name := en[item.Name]
		if locale == "zh" {
			name = zh[item.Name]
		}
		if name == "" {
			name = item.Name
		}
		// The game's grid shows the short name; keep it next to the full one for the recognition
		// matcher and for any list that has room for the shorter label.
		shortName := en[item.ShortName]
		if locale == "zh" {
			shortName = zh[item.ShortName]
		}
		if shortName == "" {
			shortName = name
		}
		categories := make([]string, 0, len(item.HandbookCategories))
		for _, id := range item.HandbookCategories {
			category := source.HandbookCategories[id]
			if !slices.Contains(itemCategories, category.NormalizedName) {
				continue
			}
			categories = append(categories, category.NormalizedName)
		}
		bestSell := bestSellOffer(item)
		var traderPrice *int
		var trader *contracts.ItemsTrader

		if bestSell != nil {
			traderPrice = &bestSell.PriceRUB
			metadata := traders[bestSell.Trader]
			trader = &contracts.ItemsTrader{Id: bestSell.Trader, Name: traderName(bestSell.Trader, metadata, en), Image: images[metadata.ImageLink]}
		}
		fleaUnavailable := slices.Contains(item.Types, "noFlea")
		fleaStatus := "available"
		if fleaUnavailable {
			fleaStatus = "noFlea"
		} else if item.LastLowPrice == nil {
			fleaStatus = "notScanned"
		}
		names := en
		if locale == "zh" {
			names = zh
		}
		lowestPrice, lowestSource := lowestItemPrice(item, traders, en, names, taskNames, source.Items, images, tasks, bartersByReward[item.ID])
		items = append(items, contracts.ItemsCatalogItem{
			Id: item.ID, Name: name, ShortName: shortName, Image: images[item.BaseImageLink], Categories: categories,
			TraderPrice: traderPrice, Trader: trader, TraderStatus: traderStatus(item),
			FleaPrice: fleaPrice(item, fleaUnavailable), FleaStatus: fleaStatus, LowestPrice: lowestPrice, LowestPriceSource: lowestSource,
		})
	}
	slices.SortFunc(items, func(a, b contracts.ItemsCatalogItem) int { return strings.Compare(a.Id, b.Id) })
	return contracts.ItemsCatalog{SchemaVersion: contracts.ContractSchemaVersion, FetchedAt: time.Now().UTC().Format(time.RFC3339Nano), Mode: mode, Items: items}
}

func traderName(id string, trader upstreamTrader, en map[string]string) string {
	if name := en[id+" Nickname"]; name != "" {
		return name
	}
	if trader.Normalized != "" {
		return trader.Normalized
	}
	return id
}

func traderStatus(item upstreamItem) string {
	if len(item.SellToTrader) > 0 {
		return "available"
	}
	return "unavailable"
}

func firstPositive(values ...*int) *int {
	for _, value := range values {
		if value != nil && *value > 0 {
			return value
		}
	}
	return nil
}

func cheapestBuyPrice(item upstreamItem) *int {
	var best *int
	consider := func(value int) {
		if value <= 0 || (best != nil && value >= *best) {
			return
		}
		copy := value
		best = &copy
	}
	if price := firstPositive(item.Avg24hPrice, item.LastLowPrice); price != nil {
		consider(*price)
	}
	for _, offer := range item.BuyFromTrader {
		consider(offer.PriceRUB)
	}
	return best
}

func requirement(itemID string, count float64, items map[string]upstreamItem, images map[string]string, names map[string]string) *contracts.ItemsRequirement {
	required, ok := items[itemID]
	if !ok || count <= 0 {
		return nil
	}
	unitPrice := cheapestBuyPrice(required)
	var totalPrice *int
	if unitPrice != nil {
		total := int(math.Round(float64(*unitPrice) * count))
		totalPrice = &total
	}
	return &contracts.ItemsRequirement{
		ItemId: itemID, Name: names[required.Name], Image: images[required.BaseImageLink],
		Count: count, UnitPrice: unitPrice, TotalPrice: totalPrice,
	}
}

// Hand-ins are the item cost of a task; shooting, visiting or locating objectives cost nothing and
// must not show up as a prerequisite purchase.
func taskUnlock(id string, taskNames map[string]string, items map[string]upstreamItem, images map[string]string, names map[string]string, tasks upstreamTasks) *contracts.ItemsTaskUnlock {
	name := taskNames[id+" name"]
	if name == "" {
		return nil
	}
	task, ok := tasks.Tasks[id]
	if !ok {
		return nil
	}
	requirements := make([]contracts.ItemsRequirement, 0)
	seen := map[string]bool{}
	for _, objective := range task.Objectives {
		if objective.Type != "giveItem" {
			continue
		}
		for _, itemID := range objective.Items {
			entry := requirement(itemID, float64(objective.Count), items, images, names)
			if entry == nil || seen[itemID] {
				continue
			}
			seen[itemID] = true
			requirements = append(requirements, *entry)
		}
	}
	return &contracts.ItemsTaskUnlock{Id: id, Name: name, Requirements: requirements}
}

func lowestItemPrice(item upstreamItem, traders map[string]upstreamTrader, en, names map[string]string, taskNames map[string]string, items map[string]upstreamItem, images map[string]string, tasks upstreamTasks, barters []upstreamBarter) (*int, *contracts.ItemsPriceSource) {
	var best *int
	var source *contracts.ItemsPriceSource
	consider := func(price int, origin contracts.ItemsPriceSource) {
		if best == nil || price < *best || (price == *best && origin.Kind == "flea") {
			value, copy := price, origin
			best, source = &value, &copy
		}
	}
	if !slices.Contains(item.Types, "noFlea") {
		if price := firstPositive(item.Avg24hPrice, item.LastLowPrice); price != nil {
			consider(*price, contracts.ItemsPriceSource{Kind: "flea", Label: "FleaMarket"})
		}
	}
	for _, offer := range item.BuyFromTrader {
		if offer.PriceRUB <= 0 || offer.MinTraderLevel < 0 {
			continue
		}
		origin := contracts.ItemsPriceSource{Kind: "trader", Label: traderOfferLabel(offer.Trader, offer.MinTraderLevel, traders, en)}
		if offer.TaskUnlock != "" {
			origin.Kind = "task"
			origin.Task = taskUnlock(offer.TaskUnlock, taskNames, items, images, names, tasks)
		}
		consider(offer.PriceRUB, origin)
	}
	for _, barter := range barters {
		entries := make([]contracts.ItemsRequirement, 0, len(barter.RequiredItems))
		cashOnly := true
		priced := len(barter.RequiredItems) > 0
		for _, required := range barter.RequiredItems {
			entry := requirement(required.Item, required.Count, items, images, names)
			if entry == nil || entry.TotalPrice == nil {
				priced = false
				break
			}
			if !moneyItems[required.Item] {
				cashOnly = false
			}
			entries = append(entries, *entry)
		}
		if !priced {
			continue
		}
		total := 0
		for _, entry := range entries {
			total += *entry.TotalPrice
		}
		origin := contracts.ItemsPriceSource{Kind: "trader", Label: traderOfferLabel(barter.Trader, barter.MinTraderLevel, traders, en)}
		if !cashOnly {
			origin.Kind = "barter"
			origin.Barter = &contracts.ItemsBarter{Items: entries}
		}
		if barter.TaskUnlock != "" {
			origin.Task = taskUnlock(barter.TaskUnlock, taskNames, items, images, names, tasks)
		}
		consider(total, origin)
	}
	return best, source
}

func traderOfferLabel(id string, level int, traders map[string]upstreamTrader, en map[string]string) string {
	return fmt.Sprintf("%s LL%d", traderName(id, traders[id], en), level)
}

func fleaPrice(item upstreamItem, unavailable bool) *int {
	if unavailable {
		return nil
	}
	// Selling to the flea pays the most recent lowest listing; the buy side used by the lowest
	// price column is the 24h average, exactly like the upstream API's sellFor/buyFor split.
	return item.LastLowPrice
}

func (m *itemsManager) downloadImages(ctx context.Context, source upstreamItems, traders map[string]upstreamTrader) (map[string]string, int, int, error) {
	root := filepath.Join(m.store.root, "upstream")
	manifestPath := filepath.Join(root, "items", "manifest.json")
	manifest := itemManifest{}
	_ = readJSON(manifestPath, &manifest)
	entries := map[string]manifestEntry{}
	for _, entry := range manifest.Sources {
		entries[entry.Source] = entry
	}
	images := map[string]string{}
	jobs := map[string]string{}
	for _, item := range source.Items {
		if item.BaseImageLink != "" {
			jobs[item.BaseImageLink] = item.ID
		}
	}
	for _, trader := range traders {
		if trader.ImageLink != "" {
			jobs[trader.ImageLink] = trader.ID
		}
	}
	m.setStatus(func(s *contracts.ItemsUpdateStatus) { s.ImagesTotal = len(jobs) })
	downloaded, skipped := 0, 0
	type result struct {
		sourceURL, itemID, file, digest string
		body                            []byte
		err                             error
	}
	downloadCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan result, len(jobs))
	var wait sync.WaitGroup
	sem := make(chan struct{}, 8)
	for sourceURL, itemID := range jobs {
		entry := entries[sourceURL]
		if entry.File != "" {
			if _, err := os.Stat(filepath.Join(root, "assets", filepath.FromSlash(entry.File))); err == nil {
				images[sourceURL] = "/api/assets/" + entry.File
				skipped++
				m.setStatus(func(s *contracts.ItemsUpdateStatus) { s.ImagesDone++ })
				continue
			}
		}
		wait.Add(1)
		go func(sourceURL, itemID string) {
			defer wait.Done()
			select {
			case sem <- struct{}{}:
			case <-downloadCtx.Done():
				results <- result{sourceURL: sourceURL, itemID: itemID, err: downloadCtx.Err()}
				return
			}
			defer func() { <-sem }()
			request, err := http.NewRequestWithContext(downloadCtx, http.MethodGet, sourceURL, nil)
			if err != nil {
				results <- result{sourceURL: sourceURL, itemID: itemID, err: err}
				return
			}
			response, err := m.client.Do(request)
			if err != nil {
				results <- result{sourceURL: sourceURL, itemID: itemID, err: err}
				return
			}
			body, readErr := io.ReadAll(io.LimitReader(response.Body, 8<<20))
			_ = response.Body.Close()
			if readErr != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
				results <- result{sourceURL: sourceURL, itemID: itemID, err: fmt.Errorf("image download failed for %s", itemID)}
				return
			}
			digest := fmt.Sprintf("%x", sha256.Sum256(body))
			ext := filepath.Ext(sourceURL)
			if ext != ".webp" && ext != ".png" && ext != ".jpg" {
				ext = ".webp"
			}
			results <- result{sourceURL: sourceURL, itemID: itemID, file: "items/item-" + digest[:24] + ext, digest: digest, body: body}
		}(sourceURL, itemID)
	}
	go func() { wait.Wait(); close(results) }()
	for item := range results {
		if item.err != nil {
			cancel()
			return nil, downloaded, skipped, item.err
		}
		target := filepath.Join(root, "assets", filepath.FromSlash(item.file))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			cancel()
			return nil, downloaded, skipped, err
		}
		if err := os.WriteFile(target, item.body, 0o644); err != nil {
			cancel()
			return nil, downloaded, skipped, err
		}
		entry := entries[item.sourceURL]
		entries[item.sourceURL] = manifestEntry{Source: item.sourceURL, File: item.file, SHA256: item.digest, Previous: entry.Previous}
		images[item.sourceURL] = "/api/assets/" + item.file
		downloaded++
		m.setStatus(func(s *contracts.ItemsUpdateStatus) { s.ImagesDone++ })
	}
	sources := make([]manifestEntry, 0, len(entries))
	for _, entry := range entries {
		sources = append(sources, entry)
	}
	slices.SortFunc(sources, func(a, b manifestEntry) int { return strings.Compare(a.Source, b.Source) })
	if err := m.store.savePath(manifestPath, itemManifest{FetchedAt: time.Now().UTC().Format(time.RFC3339Nano), Sources: sources}); err != nil {
		return nil, downloaded, skipped, err
	}
	return images, downloaded, skipped, nil
}

func (m *itemsManager) run(ctx context.Context, includeImages bool) error {
	mode := m.mode()
	// Every fetch reports itself so the dialog can show the real sub-step that is in flight.
	download := func(detail string) {
		m.setStatus(func(s *contracts.ItemsUpdateStatus) { s.Phase, s.Detail = "download", detail })
	}
	var source upstreamItems
	var traders map[string]upstreamTrader
	var zh, en map[string]string
	download("items")
	if err := m.fetchJSON(ctx, mode, "items", &source); err != nil {
		return err
	}
	download("items_zh")
	if err := m.fetchJSON(ctx, mode, "items_zh", &zh); err != nil {
		return err
	}
	download("items_en")
	if err := m.fetchJSON(ctx, mode, "items_en", &en); err != nil {
		return err
	}
	download("traders")
	if err := m.fetchJSON(ctx, mode, "traders", &traders); err != nil {
		return err
	}
	var traderEN map[string]string
	download("traders_en")
	if err := m.fetchJSON(ctx, mode, "traders_en", &traderEN); err != nil {
		return err
	}
	for key, value := range traderEN {
		en[key] = value
	}
	var tasks upstreamTasks
	var tasksZh, tasksEn map[string]string
	download("tasks")
	if err := m.fetchJSON(ctx, mode, "tasks", &tasks); err != nil {
		return err
	}
	download("tasks_zh")
	if err := m.fetchJSON(ctx, mode, "tasks_zh", &tasksZh); err != nil {
		return err
	}
	download("tasks_en")
	if err := m.fetchJSON(ctx, mode, "tasks_en", &tasksEn); err != nil {
		return err
	}
	var barters []upstreamBarter
	download("barters")
	if err := m.fetchJSON(ctx, mode, "barters", &barters); err != nil {
		return err
	}
	taskNamesZh := taskNamesFromJSON(tasksZh)
	taskNamesEn := taskNamesFromJSON(tasksEn)
	images := map[string]string{}
	if includeImages {
		m.setStatus(func(s *contracts.ItemsUpdateStatus) { s.Phase, s.Detail = "images", "imageFiles" })
		var downloaded, skipped int
		var err error
		images, downloaded, skipped, err = m.downloadImages(ctx, source, traders)
		if err != nil {
			return err
		}
		m.setStatus(func(s *contracts.ItemsUpdateStatus) {
			s.Downloaded = downloaded
			s.Skipped = skipped
		})
	} else {
		var manifest itemManifest
		if readJSON(filepath.Join(m.store.root, "upstream", "items", "manifest.json"), &manifest) == nil {
			for _, entry := range manifest.Sources {
				if entry.File != "" {
					images[entry.Source] = "/api/assets/" + entry.File
				}
			}
		}
	}
	m.setStatus(func(s *contracts.ItemsUpdateStatus) { s.Phase, s.Detail = "parse", "catalog" })
	for locale, catalog := range map[string]contracts.ItemsCatalog{"zh": itemCatalog(mode, source, traders, zh, en, images, "zh", taskNamesZh, tasks, barters), "en": itemCatalog(mode, source, traders, zh, en, images, "en", taskNamesEn, tasks, barters)} {
		if err := ctx.Err(); err != nil {
			return err
		}
		m.setStatus(func(s *contracts.ItemsUpdateStatus) { s.Phase, s.Detail = "write", "items_"+locale })
		if err := m.store.savePath(m.catalogPathFor(mode, locale), catalog); err != nil {
			return err
		}
	}
	return nil
}

func (m *itemsManager) start(includeImages bool) bool {
	m.mu.Lock()
	if m.status.Running {
		m.mu.Unlock()
		return false
	}
	if err := checkWritable(filepath.Join(m.store.root, "user"), filepath.Join(m.store.root, "upstream", "items"), filepath.Join(m.store.root, "upstream", "assets")); err != nil {
		log.Printf("items update unavailable: %v", err)
		m.status = contracts.ItemsUpdateStatus{Error: "update_failed", ErrorDetail: err.Error()}
		m.mu.Unlock()
		return true
	}
	ctx, cancel := context.WithCancel(m.ctx)
	m.cancel = cancel
	started := time.Now().UTC().Format(time.RFC3339Nano)
	m.status = contracts.ItemsUpdateStatus{
		Running: true, Phase: "download", Detail: "items", ErrorDetail: "", StartedAt: &started,
		IncludeImages: includeImages,
	}
	m.mu.Unlock()
	go func() {
		err := m.run(ctx, includeImages)
		cancel()
		finished := time.Now().UTC().Format(time.RFC3339Nano)
		m.mu.Lock()
		m.cancel = nil
		m.status.Running = false
		m.status.FinishedAt = &finished
		if errors.Is(err, context.Canceled) {
			m.status.Error = "cancelled"
		} else if err != nil {
			m.status.Error = "update_failed"
			m.status.ErrorDetail = err.Error()
		} else {
			m.status.Error = ""
		}
		m.mu.Unlock()
		// A cancelled run is a user decision; an unexpected error is the one worth a log record.
		if err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("items update failed: %v", err)
		}
		if err == nil {
			m.hub.mu.Lock()
			m.hub.publish(contracts.ServerEvent{Type: "items_changed"})
			m.hub.mu.Unlock()
		}
	}()
	return true
}

func (m *itemsManager) cancelUpdate() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
	}
	m.mu.Unlock()
}

func (m *itemsManager) autoUpdateLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			settings := m.readSettings()
			if settings.AutoUpdate {
				m.start(settings.IncludeImages)
			}
		}
	}
}

func (m *itemsManager) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/items", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		locale := mapLang(r.URL.Query().Get("locale"))
		var value contracts.ItemsCatalog
		if err := readJSON(m.catalogPath(locale), &value); err != nil || value.SchemaVersion != contracts.ContractSchemaVersion || value.Mode != m.mode() {
			apiError(w, http.StatusNotFound, "items_not_available")
			return
		}
		cachedJSONResponse(w, r, value)
	})
	mux.HandleFunc("GET /api/items-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		value, revision, etag, err := ReadVersioned(m.store.files, filepath.Join("user", "items-settings.json"), defaultItemsSettings())
		if err != nil {
			apiError(w, http.StatusInternalServerError, "items_settings_invalid")
			return
		}
		versionedJSONResponse(w, value, revision, etag)
	})
	mux.HandleFunc("PUT /api/items-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		expected, ok := requireRevision(w, r)
		if !ok {
			return
		}
		var value contracts.ItemsSettings
		if !decodeUpdate(w, r, &value) || !validItemsSettings(value) {
			apiError(w, http.StatusBadRequest, "items_settings_invalid")
			return
		}
		if err := checkWritable(filepath.Join(m.store.root, "user")); err != nil {
			dataDirError(w, err)
			return
		}
		revision, etag, err := m.store.files.Update(filepath.Join("user", "items-settings.json"), expected, defaultItemsSettings(), value, nil)
		if errors.Is(err, errRevisionConflict) {
			versionedConflict(w, revision, etag)
			return
		}
		if err != nil {
			log.Printf("save items settings: %v", err)
			apiError(w, http.StatusInternalServerError, "items_settings_save_failed")
			return
		}
		m.mu.Lock()
		m.settings = value
		m.mu.Unlock()
		versionedJSONResponse(w, value, revision, etag)
	})
	mux.HandleFunc("POST /api/items/update", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var body contracts.ItemsUpdateRequest
		if !decodeUpdate(w, r, &body) {
			return
		}
		m.mu.Lock()
		running := m.status.Running
		m.mu.Unlock()
		if running {
			apiError(w, http.StatusConflict, "items_update_in_progress")
			return
		}
		m.start(body.IncludeImages)
		jsonResponse(w, m.statusCopy())
	})
	mux.HandleFunc("GET /api/items/update", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		jsonResponse(w, m.statusCopy())
	})
	mux.HandleFunc("POST /api/items/update/cancel", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		m.cancelUpdate()
		// Answer with the status so the caller can show the cancelled run without a second poll.
		jsonResponse(w, m.statusCopy())
	})
}
