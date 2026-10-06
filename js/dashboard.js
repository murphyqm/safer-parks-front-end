// Remote data configuration - Load from GitHub instead of local files
const GITHUB_BASE_URL = 'https://raw.githubusercontent.com/Safer-Parks/E12000003/refs/heads/main';

// WYCA region center (West Yorkshire Combined Authority) - roughly centered between all 5 districts
const WYCA_COORDS = [53.7, -1.6];
const WYCA_ZOOM = 10; // Zoomed out to show entire WYCA region
const DEFAULT_ZOOM = 13; // Default zoom when viewing individual parks

// Define EPSG:27700 (British National Grid) projection
// proj4.defs will be called after proj4 library loads
function initProj4() {
    if (typeof proj4 !== 'undefined') {
        proj4.defs("EPSG:27700", "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs");
    }
}

// Transform coordinates from EPSG:27700 to WGS84 (lat/lng)
function transformCoordinates(coords, geometryType) {
    if (typeof proj4 === 'undefined') {
        console.error('proj4 library not loaded');
        return coords;
    }
    
    if (geometryType === 'Point') {
        // coords is [x, y] in BNG
        const [lng, lat] = proj4('EPSG:27700', 'EPSG:4326', coords);
        return [lng, lat];
    } else if (geometryType === 'Polygon' || geometryType === 'LineString') {
        // coords is array of [x, y] pairs
        return coords.map(coord => {
            const [lng, lat] = proj4('EPSG:27700', 'EPSG:4326', coord);
            return [lng, lat];
        });
    } else if (geometryType === 'MultiPolygon' || geometryType === 'MultiLineString') {
        // coords is array of arrays of [x, y] pairs
        return coords.map(ring => ring.map(coord => {
            const [lng, lat] = proj4('EPSG:27700', 'EPSG:4326', coord);
            return [lng, lat];
        }));
    }
    return coords;
}

// Transform GeoJSON geometry from EPSG:27700 to WGS84
function transformGeometry(geometry) {
    const transformed = { ...geometry };
    
    if (geometry.type === 'Point') {
        transformed.coordinates = transformCoordinates(geometry.coordinates, 'Point');
    } else if (geometry.type === 'LineString') {
        transformed.coordinates = transformCoordinates(geometry.coordinates, 'LineString');
    } else if (geometry.type === 'Polygon') {
        transformed.coordinates = geometry.coordinates.map(ring => 
            transformCoordinates(ring, 'Polygon')
        );
    } else if (geometry.type === 'MultiPoint') {
        transformed.coordinates = geometry.coordinates.map(coord => 
            transformCoordinates(coord, 'Point')
        );
    } else if (geometry.type === 'MultiLineString') {
        transformed.coordinates = geometry.coordinates.map(line => 
            transformCoordinates(line, 'LineString')
        );
    } else if (geometry.type === 'MultiPolygon') {
        transformed.coordinates = geometry.coordinates.map(polygon => 
            polygon.map(ring => transformCoordinates(ring, 'Polygon'))
        );
    }
    
    return transformed;
}

// Store loaded park layers
let parkLayers = {};
let currentParkName = null;
let currentLocalAuthority = null;
let parkSummaryLayer = null;
let roadSegmentRange = { min: 0, max: 100 };
let vgaVisibilityRange = { min: 0, max: 100 };
let parkDatasetCounts = {}; // Store dataset counts per park
let maxDatasetCount = 0; // Track maximum datasets available
let parkFeaturesPresent = new Set(); // Track which park features exist in current dataset

// Modal functionality - DEFINE FUNCTIONS FIRST
const modal = document.getElementById('controlsModal');
const openModalBtn = document.getElementById('openControlsGuide');
const closeModalBtns = document.querySelectorAll('.modal-close, .modal-close-btn');
const modalBackdrop = document.querySelector('.modal-backdrop');
let focusableElements = [];
let firstFocusableElement = null;
let lastFocusableElement = null;

function openControlsModal() {
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    
    // Get all focusable elements within modal
    focusableElements = modal.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    firstFocusableElement = focusableElements[0];
    lastFocusableElement = focusableElements[focusableElements.length - 1];
    
    // Focus first element
    setTimeout(() => firstFocusableElement?.focus(), 100);
    
    // Set up scroll indicator
    const modalBody = modal.querySelector('.modal-body');
    if (modalBody) {
        const checkScroll = () => {
            const isScrolledToBottom = 
                Math.abs(modalBody.scrollHeight - modalBody.scrollTop - modalBody.clientHeight) < 5;
            modalBody.classList.toggle('scrolled-to-bottom', isScrolledToBottom);
        };
        
        modalBody.addEventListener('scroll', checkScroll);
        checkScroll(); // Initial check
    }
}

function closeModal() {
    modal.classList.remove('show');
    document.body.style.overflow = '';
    openModalBtn?.focus();
}

// Open modal when button clicked
openModalBtn?.addEventListener('click', openControlsModal);

// Close modal on close button click
closeModalBtns.forEach(btn => {
    btn.addEventListener('click', closeModal);
});

// Close modal on backdrop click
modalBackdrop?.addEventListener('click', closeModal);

// Update Escape key handler to close any open modal
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (modal?.classList.contains('show')) {
            closeModal();
        } else if (laModal?.classList.contains('show')) {
            closeLAModal();
        } else if (policingModal?.classList.contains('show')) {
            closePolicingModal();
        } else {
            // Check for any open layer info modal
            const openLayerModal = document.querySelector('.layer-info-modal.show');
            if (openLayerModal) {
                openLayerModal.classList.remove('show');
                document.body.style.overflow = '';
            }
        }
    }
});

// Trap focus within modal
modal?.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
        if (e.shiftKey) {
            // Shift + Tab
            if (document.activeElement === firstFocusableElement) {
                e.preventDefault();
                lastFocusableElement?.focus();
            }
        } else {
            // Tab
            if (document.activeElement === lastFocusableElement) {
                e.preventDefault();
                firstFocusableElement?.focus();
            }
        }
    }
});

// Local Authority Modal
const laModal = document.getElementById('laModal');
const openLAModalBtn = document.getElementById('openLAModal');
const laCloseModalBtns = laModal?.querySelectorAll('.modal-close, .modal-close-btn');
const laModalBackdrop = laModal?.querySelector('.modal-backdrop');

function openLAModal() {
    laModal.classList.add('show');
    document.body.style.overflow = 'hidden';
    const focusableElements = laModal.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    setTimeout(() => focusableElements[0]?.focus(), 100);
}

function closeLAModal() {
    laModal.classList.remove('show');
    document.body.style.overflow = '';
    openLAModalBtn?.focus();
}

openLAModalBtn?.addEventListener('click', openLAModal);
laCloseModalBtns?.forEach(btn => btn.addEventListener('click', closeLAModal));
laModalBackdrop?.addEventListener('click', closeLAModal);

// Policing Modal
const policingModal = document.getElementById('policingModal');
const openPolicingModalBtn = document.getElementById('openPolicingModal');
const policingCloseModalBtns = policingModal?.querySelectorAll('.modal-close, .modal-close-btn');
const policingModalBackdrop = policingModal?.querySelector('.modal-backdrop');

function openPolicingModal() {
    policingModal.classList.add('show');
    document.body.style.overflow = 'hidden';
    const focusableElements = policingModal.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    setTimeout(() => focusableElements[0]?.focus(), 100);
}

function closePolicingModal() {
    policingModal.classList.remove('show');
    document.body.style.overflow = '';
    openPolicingModalBtn?.focus();
}

openPolicingModalBtn?.addEventListener('click', openPolicingModal);
policingCloseModalBtns?.forEach(btn => btn.addEventListener('click', closePolicingModal));
policingModalBackdrop?.addEventListener('click', closePolicingModal);

// Layer Info Modals
function openLayerInfoModal(layerId) {
    const modal = document.getElementById(`layerInfoModal-${layerId}`);
    if (modal) {
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
        const focusableElements = modal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        setTimeout(() => focusableElements[0]?.focus(), 100);
    }
}

function closeLayerInfoModal(layerId) {
    const modal = document.getElementById(`layerInfoModal-${layerId}`);
    if (modal) {
        modal.classList.remove('show');
        document.body.style.overflow = '';
    }
}

// Set up layer info modal close handlers
document.addEventListener('DOMContentLoaded', function() {
    const layerModalCloses = document.querySelectorAll('.layer-modal-close');
    layerModalCloses.forEach(btn => {
        btn.addEventListener('click', function() {
            const modal = this.closest('.layer-info-modal');
            if (modal) {
                modal.classList.remove('show');
                document.body.style.overflow = '';
            }
        });
    });
    
    // Close on backdrop click
    const layerModals = document.querySelectorAll('.layer-info-modal');
    layerModals.forEach(modal => {
        const backdrop = modal.querySelector('.modal-backdrop');
        if (backdrop) {
            backdrop.addEventListener('click', function() {
                modal.classList.remove('show');
                document.body.style.overflow = '';
            });
        }
    });
    
    // Set up action button handlers
    const actionButtons = document.querySelectorAll('.action-btn');
    actionButtons.forEach(btn => {
        btn.addEventListener('click', function() {
            const action = this.getAttribute('data-action');
            handleActionButton(action);
        });
    });
    
    // Set up Park Markers heading to open data availability modal
    const parkMarkersHeading = document.getElementById('legend-data-availability');
    if (parkMarkersHeading) {
        parkMarkersHeading.addEventListener('click', function() {
            openLayerInfoModal('data-availability');
        });
    }
});

// Handle action button clicks
function handleActionButton(action) {
    // Check if a park is loaded
    if (Object.keys(parkLayers).length === 0) {
        alert('Please select and load a park first before using this action.');
        return;
    }
    
    // Define layer configurations for each action
    const actionConfigs = {
        // Local Authority actions
        'la-accessibility': ['park-boundary', 'park-features', 'entrances'],
        'la-facilities': ['park-boundary', 'park-features', 'lighting', 'entrances'],
        'la-usage': ['park-boundary', 'roads', 'park-features'],
        'la-infrastructure': ['park-boundary', 'vga', 'entrances', 'trees', 'roads'],
        
        // Policing actions
        'police-lighting': ['park-boundary', 'lighting', 'roads'],
        'police-visibility': ['park-boundary', 'park-features', 'lighting', 'vga'],
        'police-patrol': ['park-boundary', 'roads', 'lighting'],
        'police-vawg': ['park-boundary', 'park-features', 'roads', 'lighting', 'vga']
    };
    
    const layersToShow = actionConfigs[action];
    
    if (!layersToShow) {
        console.error('Unknown action:', action);
        return;
    }
    
    // Toggle all layers off first
    Object.keys(parkLayers).forEach(layerId => {
        toggleDataLayer(layerId, false);
        // Update toggle switch
        const toggle = document.getElementById(`toggle-${layerId}`);
        if (toggle) toggle.checked = false;
    });
    
    // Toggle selected layers on
    layersToShow.forEach(layerId => {
        if (parkLayers[layerId]) {
            toggleDataLayer(layerId, true);
            // Update toggle switch
            const toggle = document.getElementById(`toggle-${layerId}`);
            if (toggle) toggle.checked = true;
        }
    });
    
    // Close the modal
    if (action.startsWith('la-')) {
        closeLAModal();
    } else if (action.startsWith('police-')) {
        closePolicingModal();
    }
}

// Initialize map (disable Leaflet's built-in attribution — we use a custom HTML attribution)
// First, initialize proj4 projection definitions
initProj4();

const map = L.map('map', {
    zoomControl: false,
    attributionControl: false
}).setView(WYCA_COORDS, WYCA_ZOOM);

// Add zoom event listener to switch between heatmap and markers for lighting and trees layers
map.on('zoomend', function() {
    const currentZoom = map.getZoom();
    const PARK_TOOLTIP_ZOOM_THRESHOLD = 14; // Show tooltips at zoom 14 or higher
    
    const lightingLayerObj = parkLayers['lighting'];
    const treesLayerObj = parkLayers['trees'];
    
    if (lightingLayerObj && lightingLayerObj.heatmapLayer && lightingLayerObj.markerLayer) {
        if (currentZoom >= 17) {
            // Switch to markers at high zoom
            if (map.hasLayer(lightingLayerObj.heatmapLayer)) {
                map.removeLayer(lightingLayerObj.heatmapLayer);
                lightingLayerObj.markerLayer.addTo(map);
                lightingLayerObj.layer = lightingLayerObj.markerLayer;
            }
        } else {
            // Switch to heatmap at lower zoom
            if (map.hasLayer(lightingLayerObj.markerLayer)) {
                map.removeLayer(lightingLayerObj.markerLayer);
                lightingLayerObj.heatmapLayer.addTo(map);
                lightingLayerObj.layer = lightingLayerObj.heatmapLayer;
            }
        }
    }
    
    if (treesLayerObj && treesLayerObj.heatmapLayer && treesLayerObj.markerLayer) {
        if (currentZoom >= 17) {
            // Switch to markers at high zoom
            if (map.hasLayer(treesLayerObj.heatmapLayer)) {
                map.removeLayer(treesLayerObj.heatmapLayer);
                treesLayerObj.markerLayer.addTo(map);
                treesLayerObj.layer = treesLayerObj.markerLayer;
            }
        } else {
            // Switch to heatmap at lower zoom
            if (map.hasLayer(treesLayerObj.markerLayer)) {
                map.removeLayer(treesLayerObj.markerLayer);
                treesLayerObj.heatmapLayer.addTo(map);
                treesLayerObj.layer = treesLayerObj.heatmapLayer;
            }
        }
    }
    
    // Toggle park name tooltips based on zoom level
    if (parkSummaryLayer) {
        parkSummaryLayer.eachLayer(function(layer) {
            if (currentZoom >= PARK_TOOLTIP_ZOOM_THRESHOLD) {
                layer.openTooltip();
            } else {
                layer.closeTooltip();
            }
        });
    }
});

// Define tile layers
const minimalLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors, &copy; CARTO'
});

const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
});

// Set initial layer
let currentLayer = 'minimal';
minimalLayer.addTo(map);

// Park summary layer toggle functionality
const parkSummaryToggle = document.getElementById('parkSummaryToggle');
parkSummaryToggle.addEventListener('change', function() {
    if (parkSummaryLayer) {
        if (this.checked) {
            parkSummaryLayer.addTo(map);
        } else {
            map.removeLayer(parkSummaryLayer);
        }
    }
    
    // Toggle park markers legend visibility
    const legendContent = document.getElementById('legend-content');
    if (legendContent) {
        const parkMarkersSection = legendContent.querySelector('.legend-section:first-child');
        if (parkMarkersSection) {
            parkMarkersSection.style.display = this.checked ? 'block' : 'none';
        }
    }
});

// Map layer toggle functionality
const detailedToggle = document.getElementById('detailedToggle');
let isDetailedMode = false;

detailedToggle.addEventListener('change', function() {
    isDetailedMode = this.checked;

    if (isDetailedMode) {
        // Switch to OSM (detailed)
        map.removeLayer(minimalLayer);
        osmLayer.addTo(map);
    } else {
        // Switch to minimal
        map.removeLayer(osmLayer);
        minimalLayer.addTo(map);
    }
});

// Reset map view
document.getElementById('resetMapBtn').addEventListener('click', function() {
    // Reset map position to WYCA-wide view
    map.setView(WYCA_COORDS, WYCA_ZOOM);
    
    // Clear all park-specific data layers
    Object.values(parkLayers).forEach(layerObj => {
        if (layerObj.layer) map.removeLayer(layerObj.layer);
    });
    parkLayers = {};
    currentParkName = null;
    
    // Hide zoom hint text and layer order hint
    const zoomHint = document.getElementById('zoomHintText');
    if (zoomHint) zoomHint.style.display = 'none';
    const layerOrderHint = document.getElementById('layerOrderHintText');
    if (layerOrderHint) layerOrderHint.style.display = 'none';
    
    // Reset legend heading to "Legend"
    const legendTitle = document.querySelector('.legend-sidebar .accordion-title');
    if (legendTitle) {
        legendTitle.textContent = 'Legend';
    }
    
    // Clear the data layer toggles
    const togglesContainer = document.getElementById('dataLayerToggles');
    if (togglesContainer) {
        togglesContainer.innerHTML = '';
    }
    
    // Clear the data layers legend
    const legendContainer = document.getElementById('dataLayersLegend');
    if (legendContainer) {
        legendContainer.style.display = 'none';
        legendContainer.innerHTML = '';
    }
    
    // Reset park dropdown to default
    const parksSelect = document.getElementById('parks');
    if (parksSelect) {
        parksSelect.value = '';
    }
    
    // Ensure park summary layer is visible
    if (parkSummaryLayer && !map.hasLayer(parkSummaryLayer)) {
        parkSummaryLayer.addTo(map);
        parkSummaryToggle.checked = true;
    }
});

// Capture map functionality
document.getElementById('captureMapBtn').addEventListener('click', async function() {
    const button = this;
    const originalText = button.innerHTML;
    
    // Show loading state
    button.innerHTML = '⏳ Capturing...';
    button.disabled = true;
    
    // Hide elements we don't want in the capture (keep nav visible but hide menu items)
    const navLinks = document.querySelectorAll('nav ul li:not(:first-child)'); // All except title
    const leftSidebar = document.querySelector('aside:not(.legend-sidebar)');
    const zoomControl = document.querySelector('.leaflet-control-zoom');
    const legendSidebar = document.querySelector('.legend-sidebar');
    
    navLinks.forEach(li => li.style.display = 'none');
    if (leftSidebar) leftSidebar.style.display = 'none';
    if (zoomControl) zoomControl.style.display = 'none';
    
    // Clone legend with proper dimensions for capture
    let legendClone = null;
    if (legendSidebar) {
        // Hide original
        legendSidebar.style.display = 'none';
        
        // Create clone
        legendClone = legendSidebar.cloneNode(true);
        legendClone.style.cssText = `
            position: fixed;
            top: 4rem;
            right: 1rem;
            width: 320px !important;
            min-width: 320px !important;
            max-width: 320px !important;
            transform: none !important;
            z-index: 1000;
        `;
        
        // Fix all text elements in clone
        const allElements = legendClone.querySelectorAll('*');
        allElements.forEach(el => {
            el.style.whiteSpace = 'normal';
            el.style.wordWrap = 'break-word';
            el.style.maxWidth = '100%';
        });
        
        // Fix SVG gradient IDs to prevent conflicts with original
        const svgGradients = legendClone.querySelectorAll('defs linearGradient, defs radialGradient');
        svgGradients.forEach(gradient => {
            const oldId = gradient.id;
            const newId = oldId + '-clone';
            gradient.id = newId;
            
            // Update references to this gradient
            const fills = legendClone.querySelectorAll(`[fill="url(#${oldId})"]`);
            fills.forEach(el => {
                el.setAttribute('fill', `url(#${newId})`);
            });
        });
        
        document.body.appendChild(legendClone);
        
        // Force reflow
        void legendClone.offsetHeight;
    }
    
    // Generate filename
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const parkName = currentParkName ? currentParkName.replace(/ /g, '_') : 'map';
    const filename = `${parkName}_${timestamp}.png`;
    
    // Wait for layout to settle
    setTimeout(async () => {
        try {
            const blob = await modernScreenshot.domToBlob(document.body, {
                scale: 2,
                backgroundColor: '#ffffff',
                quality: 1.0
            });
            
            // Restore all elements
            navLinks.forEach(li => li.style.display = '');
            if (leftSidebar) leftSidebar.style.display = '';
            if (zoomControl) zoomControl.style.display = '';
            
            // Remove clone and restore original legend
            if (legendClone) {
                document.body.removeChild(legendClone);
            }
            if (legendSidebar) {
                legendSidebar.style.display = '';
            }
            
            // Download the blob
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = filename;
            link.href = url;
            link.click();
            URL.revokeObjectURL(url);
            
            // Reset button
            button.innerHTML = originalText;
            button.disabled = false;
        } catch (err) {
            console.error('Error capturing map:', err);
            
            // Restore on error
            navLinks.forEach(li => li.style.display = '');
            if (leftSidebar) leftSidebar.style.display = '';
            if (zoomControl) zoomControl.style.display = '';
            
            if (legendClone && document.body.contains(legendClone)) {
                document.body.removeChild(legendClone);
            }
            if (legendSidebar) {
                legendSidebar.style.display = '';
            }
            
            button.innerHTML = originalText;
            button.disabled = false;
            alert('Error capturing map: ' + err.message);
        }
    }, 500);
});

// Get layer modal content as plain text
function getLayerModalContentAsText(layerId) {
    const modal = document.getElementById(`layerInfoModal-${layerId}`);
    if (!modal) return '';
    
    const title = modal.querySelector('.modal-header h2')?.textContent || '';
    const sections = modal.querySelectorAll('.modal-body section');
    
    let text = `${title}\n`;
    text += '='.repeat(title.length) + '\n\n';
    
    sections.forEach(section => {
        const heading = section.querySelector('h3')?.textContent || '';
        const paragraph = section.querySelector('p')?.textContent || '';
        
        if (heading) {
            text += `${heading}\n`;
            text += '-'.repeat(heading.length) + '\n';
        }
        if (paragraph) {
            text += `${paragraph}\n`;
        }
        
        // Special handling for demographics table
        if (layerId === 'demographics') {
            const table = section.querySelector('table');
            if (table) {
                text += '\n';
                const rows = table.querySelectorAll('tbody tr');
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length === 2) {
                        const label = cells[0].textContent.trim();
                        const value = cells[1].textContent.trim();
                        text += `${label}: ${value}\n`;
                    }
                });
            }
        }
        
        text += '\n';
    });
    
    return text;
}

// Copy layer details functionality
document.getElementById('copyLayerDetailsBtn').addEventListener('click', function() {
    const button = this;
    const originalText = button.innerHTML;
    
    // Get currently visible layers
    const visibleLayers = Object.entries(parkLayers)
        .filter(([id, layerObj]) => layerObj.visible)
        .map(([id, layerObj]) => ({
            id: id,
            name: layerObj.name
        }));
    
    if (visibleLayers.length === 0) {
        alert('No data layers are currently visible');
        return;
    }
    
    // Build the layer details text using modal content
    let detailsText = currentParkName ? `Park: ${currentParkName}\n` : '';
    detailsText += `${new Date().toLocaleString()}\n`;
    detailsText += '='.repeat(50) + '\n\n';
    
    visibleLayers.forEach((layer, index) => {
        const modalContent = getLayerModalContentAsText(layer.id);
        if (modalContent) {
            detailsText += modalContent;
        }
        if (index < visibleLayers.length - 1) {
            detailsText += '\n' + '='.repeat(50) + '\n\n';
        }
    });
    
    detailsText += '\n' + '='.repeat(50) + '\n';
    detailsText += 'Source: Safer Parks Dashboard - University of Leeds\n';
    detailsText += 'Generated: ' + new Date().toLocaleString();
    
    // Copy to clipboard
    navigator.clipboard.writeText(detailsText)
        .then(() => {
            button.innerHTML = '✓ Copied!';
            setTimeout(() => {
                button.innerHTML = originalText;
            }, 2000);
        })
        .catch(err => {
            console.error('Failed to copy:', err);
            alert('Failed to copy to clipboard. Please try again.');
        });
});

document.getElementById('downloadRawDataBtn').addEventListener('click', function() {
    if (!currentParkName || !currentLocalAuthority) {
        alert('Please select and load a park first');
        return;
    }
    
    // Convert park name to folder format using the same sanitization function
    const parkFolderName = sanitizeForFolder(currentParkName);
    
    // Construct the GitHub URL to the park's dataset folder
    const githubUrl = `https://github.com/Safer-Parks/safer-parks.github.io/tree/main/datasets/${currentLocalAuthority}/${parkFolderName}`;
    
    // Open the GitHub folder in a new tab
    window.open(githubUrl, '_blank');
});

// Get descriptive text for each layer type

// Accessible Accordion Functionality
function initAccordion() {
    const accordionTriggers = document.querySelectorAll('.accordion-trigger');

    accordionTriggers.forEach(trigger => {
        const panel = document.getElementById(trigger.getAttribute('aria-controls'));
        
        if (!panel) return;

        trigger.addEventListener('click', function() {
            const isExpanded = this.getAttribute('aria-expanded') === 'true';
            
            // Toggle aria-expanded
            this.setAttribute('aria-expanded', !isExpanded);
            
            // Toggle panel visibility
            if (isExpanded) {
                panel.setAttribute('hidden', '');
            } else {
                panel.removeAttribute('hidden');
            }
        });

        // Keyboard support
        trigger.addEventListener('keydown', function(e) {
            // Space or Enter key
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                this.click();
            }
        });
    });
}

// Initialize accordion when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAccordion);
} else {
    initAccordion();
}

// Add zoom controls (custom positioning outside the map)
L.control.zoom({
    position: 'bottomright'
}).addTo(map);

// Load and display parks GeoJSON based on LA selection
let parksData = null;
let catchmentsData = null;
let parkNameMapping = {}; // Map sanitized folder names back to proper park names
let parkDemographicsData = null; // Store the new park-specific demographics dataset

// Local Authority dropdown change handler
const localAuthoritySelect = document.getElementById('localAuthority');
const parksSelect = document.getElementById('parks');
const loadParkBtn = document.getElementById('loadPark');

// Initialize by discovering available LADs from filesystem
async function initializeLADropdown() {
    try {
        // Load E12000003_lut.geojson locally to get proper LAD names
        const response = await fetch('../E12000003_lut.geojson');
        const parkInfo = await response.json();
        console.log('parkInfo features:', parkInfo.features.length);
        
        // Load the new park-specific demographics dataset if available
        try {
            // Try to load demographics data from GitHub E12000003 repo if it exists
            const demographicsResponse = await fetch(`${GITHUB_BASE_URL}/wyca_park_catchment_demographics_by_var_and_by_park.geojson`);
            if (demographicsResponse.ok) {
                parkDemographicsData = await demographicsResponse.json();
                console.log('Loaded park demographics dataset with', parkDemographicsData.features.length, 'parks');
            }
        } catch (err) {
            console.warn('Could not load park demographics dataset:', err);
        }
        
        // Get unique LADs from park information
        const ladsFromData = new Set(parkInfo.features.map(f => f.properties['LAD']));
        const ladsArray = Array.from(ladsFromData).sort();
        console.log('LADs found:', ladsArray);
        
        // On GitHub Pages, we can't check if folders exist, so just use the LADs from the data
        const validLads = ladsArray;
        console.log('validLads:', validLads);
        
        // Populate the dropdown with valid LADs
        localAuthoritySelect.innerHTML = '<option value="">-- Select an area --</option>';
        console.log('Populating dropdown with', validLads.length, 'options');
        validLads.forEach(lad => {
            const option = document.createElement('option');
            option.value = lad;
            option.textContent = lad;
            localAuthoritySelect.appendChild(option);
        });
        console.log('Dropdown populated, options:', localAuthoritySelect.options.length);
    } catch (err) {
        console.error('Error initializing LAD dropdown:', err);
    }
}

localAuthoritySelect.addEventListener('change', function() {
    const selectedLA = this.value;
    
    if (!selectedLA) {
        // Reset when no LA selected
        currentLocalAuthority = null;
        parksSelect.disabled = true;
        parksSelect.innerHTML = '<option value="">-- Select an area first --</option>';
        loadParkBtn.disabled = true;
        
        // Clear park summary layer if exists
        if (parkSummaryLayer) {
            map.removeLayer(parkSummaryLayer);
            parkSummaryLayer = null;
        }
        return;
    }
    
    // Store the selected LA
    currentLocalAuthority = selectedLA;
    
    // Enable parks dropdown
    parksSelect.disabled = false;
    parksSelect.innerHTML = '<option value="">-- Loading parks... --</option>';
    
    // Load parks for the selected LA
    loadParksForLA(selectedLA);
});

function loadParksForLA(laName) {
    // Remove previous parks layer if it exists
    if (parkSummaryLayer) {
        map.removeLayer(parkSummaryLayer);
        parkSummaryLayer = null;
    }
    
    // Clear previous park data
    parkLayers = {};
    parkDatasetCounts = {};
    maxDatasetCount = 0;
    
    // Load the main parks information from E12000003_lut.geojson (loaded locally)
    Promise.all([
        fetch('../E12000003_lut.geojson').then(r => r.json())
    ])
    .then(([parkInfoData]) => {
        // Filter parks for the selected LA from local LUT data
        const laParks = {
            type: 'FeatureCollection',
            features: parkInfoData.features.filter(f => f.properties['LAD'] === laName)
        };
        
        console.log(`Loaded ${laParks.features.length} parks from WYCA data for ${laName}`);
        
        // Deduplicate parks by name - keep first occurrence
        const seenParkNames = new Set();
        const uniqueParks = laParks.features.filter(feature => {
            const parkName = feature.properties['Park Name'];
            if (seenParkNames.has(parkName)) {
                return false; // Skip duplicate
            }
            seenParkNames.add(parkName);
            return true;
        });
        
        console.log(`Loaded ${laParks.features.length} parks from WYCA data for ${laName}`);
        console.log(`After deduplication: ${uniqueParks.length} unique parks`);
        
        if (laParks.features.length !== uniqueParks.length) {
            console.warn(`Found and removed ${laParks.features.length - uniqueParks.length} duplicate park entries`);
        }
        
        // Build a mapping of sanitized folder names to proper park names
        parkNameMapping = {};
        uniqueParks.forEach(feature => {
            const properName = feature.properties['Park Name'];
            const sanitizedName = sanitizeForFolder(properName);
            parkNameMapping[sanitizedName] = properName;
        });
        
        console.log(`parkNameMapping has ${Object.keys(parkNameMapping).length} unique sanitized names`);
        
        // For GitHub Pages, we can't fetch directory listings, so just use all WYCA parks
        const availableParks = uniqueParks;
        
        console.log(`Using ${availableParks.length} parks from WYCA data`);
        
        const filteredLaParks = {
            type: 'FeatureCollection',
            features: availableParks
        };
        
        parksData = filteredLaParks;
        
        console.log(`filteredLaParks has ${filteredLaParks.features.length} parks`);
        console.log('First park:', filteredLaParks.features[0]);
        
        // Add GeoJSON layer with pie chart markers IMMEDIATELY (before counting datasets)
        parkSummaryLayer = L.geoJSON(filteredLaParks, {
            filter: function(feature) {
                const hasGeometry = feature.geometry !== null;
                if (!hasGeometry) {
                    console.warn(`Feature ${feature.properties['Park Name']} has no geometry`);
                }
                return hasGeometry;
            },
            pointToLayer: function(feature, latlng) {
                console.log(`Creating marker for ${feature.properties['Park Name']} at`, latlng);
                // Initially show pie charts as empty until dataset counts are ready
                const parkName = feature.properties['Park Name'];
                
                // Determine park size color: green for large, purple for small
                const isLarge = feature.properties['10 ha'];
                const markerColor = isLarge ? '#31a354' : '#714a6d'; // Green for large, purple for small
                
                const icon = L.divIcon({
                    className: 'custom-park-marker',
                    html: createPieChartMarker(0, markerColor),
                    iconSize: [32, 32],
                    iconAnchor: [16, 16],
                    popupAnchor: [0, -16]
                });
                
                return L.marker(latlng, { icon: icon });
            },
            onEachFeature: function(feature, layer) {
                if (feature.properties) {
                    const props = feature.properties;
                    const parkName = props['Park Name'];
                    const datasetCount = parkDatasetCounts[parkName] || 0;
                    
                    let popupContent = `
                        <div class="park-popup">
                            <h3>${parkName}</h3>
                            <div class="park-details">
                                <p><strong>Location:</strong> ${props['Location'] || 'N/A'}</p>
                                <p><strong>Opening Hours:</strong> ${props['Opening Hours'] || 'N/A'}</p>
                                <p><strong>Available Datasets:</strong> ${datasetCount} / ${maxDatasetCount}</p>
                            </div>
                    `;
                    
                    if (props['Park features str'] && props['Park features str'] !== 'NA') {
                        const features = props['Park features str'].split(', ');
                        popupContent += `
                            <div class="park-features">
                                <p><strong>Features:</strong></p>
                                <ul>
                                    ${features.map(feature => `<li>${feature}</li>`).join('')}
                                </ul>
                            </div>
                        `;
                    }
                    
                    if (props['Park URL']) {
                        popupContent += `
                            <div class="park-link">
                                <a href="${props['Park URL']}" target="_blank" rel="noopener">View Park Details →</a>
                            </div>
                        `;
                    }
                    
                    popupContent += `</div>`;
                    
                    layer.bindPopup(popupContent);
                    layer.bindTooltip(`${parkName}`, {
                        permanent: false,
                        direction: 'top',
                        className: 'park-tooltip',
                        offset: [15, 0]
                    });
                }
            }
        });
        
        console.log(`parkSummaryLayer created with ${Object.keys(parkSummaryLayer._layers || {}).length} layers`);
        parkSummaryLayer.addTo(map);
        console.log('parkSummaryLayer added to map');
        
        // Count datasets for each park and update pie charts
        countDatasetsForParks(laName, filteredLaParks).then(() => {
            console.log(`After countDatasetsForParks: maxDatasetCount=${maxDatasetCount}, parks count=${Object.keys(parkDatasetCounts).length}`);
            populateParksDropdown(filteredLaParks);
            
            // Update pie chart markers with real dataset counts
            parkSummaryLayer.eachLayer(layer => {
                if (layer.feature && layer.feature.properties) {
                    const parkName = layer.feature.properties['Park Name'];
                    const sanitizedParkName = sanitizeForFolder(parkName);
                    const datasetCount = parkDatasetCounts[sanitizedParkName] || 0;
                    const percentage = maxDatasetCount > 0 ? (datasetCount / maxDatasetCount) : 0;
                    
                    console.log(`Park: ${parkName} -> ${sanitizedParkName}: ${datasetCount}/${maxDatasetCount} (${(percentage*100).toFixed(1)}%)`);
                    
                    // Determine park size color: green for large, purple for small
                    const isLarge = layer.feature.properties['10 ha'];
                    const markerColor = isLarge ? '#31a354' : '#714a6d'; // Green for large, purple for small
                    
                    const icon = L.divIcon({
                        className: 'custom-park-marker',
                        html: createPieChartMarker(percentage, markerColor),
                        iconSize: [32, 32],
                        iconAnchor: [16, 16],
                        popupAnchor: [0, -16]
                    });
                    
                    layer.setIcon(icon);
                }
            });
        }).catch(err => {
            console.error('Error loading park data:', err);
            parksSelect.innerHTML = '<option value="">-- Error loading parks --</option>';
        });
    }).catch(err => {
        console.error('Error discovering parks:', err);
        parksSelect.innerHTML = '<option value="">-- Error discovering parks --</option>';
    });
}

// Count available datasets for each park
async function countDatasetsForParks(laName, parksData) {
    parkDatasetCounts = {};
    maxDatasetCount = 0;
    
    try {
        // Load pre-computed dataset counts from GitHub
        const response = await fetch(`${GITHUB_BASE_URL}/dataset-counts.json`);
        const counts = await response.json();
        
        maxDatasetCount = counts.maxCount;
        parkDatasetCounts = counts.parks;
        
        console.log(`Loaded dataset counts: max=${maxDatasetCount}, total parks=${Object.keys(parkDatasetCounts).length}`);
    } catch (err) {
        console.error('Error loading dataset counts:', err);
        // Fallback: set all parks to 0
        parksData.features.forEach(feature => {
            parkDatasetCounts[feature.properties['Park Name']] = 0;
        });
        maxDatasetCount = 0;
    }
    
    return Promise.resolve();
}

// Create pie chart marker SVG
// color: '#714a6d' for small parks (purple), '#31a354' for large parks (green)
function createPieChartMarker(percentage, color = '#714a6d') {
    const size = 32;
    const radius = 14;
    const cx = size / 2;
    const cy = size / 2;
    
    // Calculate pie slice
    const angle = percentage * 360;
    const radians = (angle - 90) * (Math.PI / 180);
    const x = cx + radius * Math.cos(radians);
    const y = cy + radius * Math.sin(radians);
    
    // Determine if we need large arc flag
    const largeArcFlag = angle > 180 ? 1 : 0;
    
    // Create path for pie slice
    let pathData;
    if (percentage === 0) {
        pathData = ''; // Empty pie
    } else if (percentage === 1) {
        // Full circle
        pathData = `M ${cx},${cy} m -${radius},0 a ${radius},${radius} 0 1,0 ${radius * 2},0 a ${radius},${radius} 0 1,0 -${radius * 2},0`;
    } else {
        // Partial pie
        pathData = `M ${cx},${cy} L ${cx},${cy - radius} A ${radius},${radius} 0 ${largeArcFlag},1 ${x},${y} Z`;
    }
    
    return `
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
            <circle cx="${cx}" cy="${cy}" r="${radius}" fill="#e5e7eb" fill-opacity="0.5" stroke="#9ca3af" stroke-width="2"/>
            ${percentage > 0 ? `<path d="${pathData}" fill="${color}" fill-opacity="0.7" stroke="${color}" stroke-width="1"/>` : ''}
            <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#374151" stroke-width="2" opacity="0.6"/>
        </svg>
    `;
}

// Function to load park-specific data
async function loadParkData(parkName) {
    // Clear existing park layers
    Object.values(parkLayers).forEach(layerObj => {
        if (layerObj.layer) map.removeLayer(layerObj.layer);
    });
    parkLayers = {};
    currentParkName = parkName;
    
    // Update legend heading with park name
    const legendTitle = document.querySelector('.legend-sidebar .accordion-title');
    if (legendTitle) {
        legendTitle.textContent = parkName;
    }
    
    // Show zoom hint text and layer order hint
    const zoomHint = document.getElementById('zoomHintText');
    if (zoomHint) zoomHint.style.display = 'block';
    const layerOrderHint = document.getElementById('layerOrderHintText');
    if (layerOrderHint) layerOrderHint.style.display = 'block';
    
    // Clear previous toggles and legend
    document.getElementById('dataLayerToggles').innerHTML = '';
    document.getElementById('dataLayersLegend').innerHTML = '';
    
    // Reset the set of park features present in this park
    parkFeaturesPresent = new Set();
    
    // Zoom to the park marker from WYCA_park_information.geojson
    if (parksData) {
        const parkFeature = parksData.features.find(
            feature => feature.properties['Park Name'] === parkName
        );
        if (parkFeature && parkFeature.geometry && parkFeature.geometry.coordinates) {
            const coords = parkFeature.geometry.coordinates;
            map.setView([coords[1], coords[0]], 16); // GeoJSON uses [lon, lat]
            
            // Turn off park summaries when zooming into a specific park
            if (parkSummaryToggle && parkSummaryToggle.checked) {
                parkSummaryToggle.checked = false;
                parkSummaryToggle.dispatchEvent(new Event('change'));
            }
        }
    }
    
    // Check if LA is selected
    if (!currentLocalAuthority) {
        alert('Please select a Local Authority Area first');
        return;
    }
    
    // Create folder name from park name using consistent sanitization
    const folderName = sanitizeForFolder(parkName);
    const basePath = `${GITHUB_BASE_URL}/${currentLocalAuthority}/${folderName}/`;
    
    // Dynamically discover all .geojson files in the park folder
    // Note: GitHub raw content doesn't support directory listing, so we'll use predefined datasets
    let allFiles = [];
    
    // Check if park exists in the new demographics dataset
    let useParkDemographicsDataset = false;
    if (parkDemographicsData && parkDemographicsData.features) {
        const parkFeature = parkDemographicsData.features.find(
            feature => feature.properties && feature.properties['Primary Name'] === parkName
        );
        if (parkFeature) {
            useParkDemographicsDataset = true;
            console.log(`Found ${parkName} in park demographics dataset, will use that instead of individual file`);
        }
    }
    
    // If directory listing didn't work, fall back to predefined datasets
    if (allFiles.length === 0) {
        allFiles = [
            `${currentLocalAuthority}_${folderName}_WYCA_park_boundaries.geojson`,
            `${currentLocalAuthority}_${folderName}_OSM_trees.geojson`,
            `${currentLocalAuthority}_${folderName}_OSM_park_features_general.geojson`,
            `${currentLocalAuthority}_${folderName}_OSM_benches_picnic.geojson`,
            `${currentLocalAuthority}_${folderName}_${currentLocalAuthority.toLowerCase()}__NAChR800.geojson`,
            `${currentLocalAuthority}_${folderName}_park_street_lights.geojson`,
            `${currentLocalAuthority}_${folderName}_external_entrances.geojson`,
            `${currentLocalAuthority}_${folderName}_buffer_boundary.geojson`,
            `${currentLocalAuthority}_${folderName}_summer_vga.geojson`
        ];
    }
    
    // Map filenames to layer IDs and names
    const datasetMapping = {
        'WYCA_park_boundaries': { id: 'park-boundary', name: 'Park Boundary' },
        'OSM_trees': { id: 'trees', name: 'Trees' },
        'OSM_park_features_general': { id: 'park-features', name: 'Park Features' },
        'OSM_benches_picnic': { id: 'benches', name: 'Benches & Picnic Tables' },
        '__NAChR800': { id: 'roads', name: 'Predicted Route Popularity' },
        'park_street_lights': { id: 'lighting', name: 'Street Lighting' },
        'external_entrances': { id: 'entrances', name: 'Park Entrances' },
        'buffer_boundary': { id: 'buffer', name: 'Catchment Buffer' },
        'summer_vga': { id: 'vga', name: 'Visibility Analysis' }
    };
    
    // Convert filenames to layer info
    const dataLayers = allFiles
        .map(file => {
            // Extract the dataset name from filename
            // Try to match known dataset suffixes
            let datasetName = null;
            
            // Check for known suffixes
            const knownSuffixes = [
                'WYCA_park_boundaries',
                'OSM_trees',
                'OSM_park_features_general',
                'OSM_benches_picnic',
                '__NAChR800',
                'park_street_lights',
                'external_entrances',
                'buffer_boundary',
                'summer_vga'
            ];
            
            for (const suffix of knownSuffixes) {
                if (file.includes(suffix)) {
                    datasetName = suffix;
                    break;
                }
            }
            
            if (!datasetName) {
                console.log(`Skipping file with unknown suffix: ${file}`);
                return null;
            }
            
            const mapping = datasetMapping[datasetName];
            if (!mapping) {
                console.log(`No mapping found for dataset name: ${datasetName} in file ${file}`);
                return null;
            }
            
            console.log(`Mapped file "${file}" to dataset "${datasetName}" -> layer "${mapping.id}"`);
            
            return {
                file: file,
                name: mapping.name,
                id: mapping.id
            };
        })
        .filter(layer => layer !== null);
    
    // Try to load each file
    const loadPromises = dataLayers.map(layerInfo => {
        // Default behavior: load from file
        const filePath = basePath + layerInfo.file;
        console.log(`Fetching layer: ${layerInfo.id} from ${filePath}`);
        
        return fetch(filePath)
            .then(response => {
                if (!response.ok) {
                    console.warn(`Failed to load ${layerInfo.id} (${filePath}): ${response.status}`);
                    return null;
                }
                return response.json();
            })
            .then(data => {
                if (data) {
                    console.log(`Successfully loaded ${layerInfo.id} (${layerInfo.file})`);
                } else {
                    console.warn(`No data returned for ${layerInfo.id} (${layerInfo.file})`);
                }
                if (data) {
                    let layer;
                    
                    // Handle lighting as heatmap with marker fallback
                    if (layerInfo.id === 'lighting') {
                        const heatmapData = data.features.map(feature => {
                            const coords = feature.geometry.coordinates;
                            // Use intensity 1.0 for all lights (maximum intensity)
                            // Coordinates: [lon, lat] -> [lat, lon, intensity]
                            return [coords[1], coords[0], 1.0];
                        }).filter(coords => coords[0] && coords[1]);
                        
                        console.log(`Lighting heatmap points: ${heatmapData.length}`);
                        
                        const heatmapLayer = L.heatLayer(heatmapData, {
                            radius: 15,
                            blur: 20,
                            maxZoom: 17,
                            minOpacity: 0.4,
                            max: 1.0,
                            gradient: {
                                0.0: 'rgba(255,150,0,0)',
                                0.25: 'rgba(255,150,0,0.5)',
                                0.5: 'rgba(255,165,0,0.7)',
                                0.75: 'rgba(255,200,0,0.8)',
                                1.0: 'rgba(255,255,0,0.9)',
                            }
                        });
                        
                        const markerLayer = L.geoJSON(data, {
                            pointToLayer: function(feature, latlng) {
                                return getPointStyleForFile(layerInfo.id, latlng);
                            }
                        });
                        
                        const currentZoom = map.getZoom();
                        if (currentZoom >= 17) {
                            layer = markerLayer;
                        } else {
                            layer = heatmapLayer;
                        }
                        // Only add lighting layer if it's checked by default (which it's not)
                        // layer.addTo(map);
                        
                        parkLayers[layerInfo.id] = {
                            layer: layer,
                            heatmapLayer: heatmapLayer,
                            markerLayer: markerLayer,
                            name: layerInfo.name,
                            visible: false
                        };
                        return layerInfo;
                    }
                    else {
                        // Calculate min/max for road segment values
                        if (layerInfo.id === 'roads') {
                            console.log(`Loading roads layer with ${data.features.length} features`);
                            const values = [];
                            data.features.forEach(feature => {
                                if (feature.properties) {
                                    const value = feature.properties.NACh_calculated;
                                    if (value !== undefined && value !== null && !isNaN(value)) {
                                        values.push(Number(value));
                                    }
                                }
                            });
                            
                            if (values.length > 0) {
                                roadSegmentRange.min = Math.min(...values);
                                roadSegmentRange.max = Math.max(...values);
                                console.log(`Road segment range: min=${roadSegmentRange.min}, max=${roadSegmentRange.max}, count=${values.length}`);
                                console.log(`Sample values:`, values.slice(0, 10));
                            } else {
                                console.warn('No road segment values found in dataset');
                            }
                        }
                        
                        // Calculate min/max for visibility_pct values
                        if (layerInfo.id === 'vga') {
                            const values = [];
                            data.features.forEach(feature => {
                                if (feature.properties) {
                                    const value = feature.properties.visibility_pct;
                                    if (value !== undefined && value !== null && !isNaN(value)) {
                                        values.push(Number(value));
                                    }
                                }
                            });
                            
                            if (values.length > 0) {
                                vgaVisibilityRange.min = Math.min(...values);
                                vgaVisibilityRange.max = Math.max(...values);
                                console.log(`VGA visibility range: min=${vgaVisibilityRange.min}, max=${vgaVisibilityRange.max}, count=${values.length}`);
                            } else {
                                console.warn('No visibility_pct values found in VGA dataset');
                            }
                        }
                        
                        // Handle trees as heatmap with marker fallback
                        if (layerInfo.id === 'trees') {
                            const heatmapData = data.features.map(feature => {
                                const coords = feature.geometry.coordinates;
                                if (feature.geometry.type === 'Point') {
                                    return [coords[1], coords[0], 1.0];
                                } else if (feature.geometry.type === 'LineString') {
                                    // Calculate centroid of line
                                    const len = coords.length;
                                    const mid = Math.floor(len / 2);
                                    return [coords[mid][1], coords[mid][0], 0.8];
                                }
                                return null;
                            }).filter(coords => coords !== null && coords[0] && coords[1]);
                            
                            console.log(`Trees heatmap points: ${heatmapData.length}`);
                            
                            const heatmapLayer = L.heatLayer(heatmapData, {
                                radius: 12, // tighter radius for trees
                                blur: 15,
                                maxZoom: 17,
                                minOpacity: 0.3,
                                max: 1.0,
                                gradient: {
                                    0.0: 'rgba(34,197,94,0)',
                                    0.25: 'rgba(34,197,94,0.3)',
                                    0.5: 'rgba(34,197,94,0.6)',
                                    0.75: 'rgba(34,197,94,0.8)',
                                    1.0: 'rgba(34,197,94,0.9)',
                                }
                            });
                            
                            const markerLayer = L.geoJSON(data, {
                                style: function(feature) {
                                    // Only apply style for non-point features
                                    if (feature.geometry.type !== 'Point') {
                                        return getStyleForFile(layerInfo.id, feature);
                                    }
                                },
                                pointToLayer: function(feature, latlng) {
                                    return getPointStyleForFile(layerInfo.id, latlng);
                                }
                            });
                            
                            const currentZoom = map.getZoom();
                            if (currentZoom >= 17) {
                                layer = markerLayer;
                            } else {
                                layer = heatmapLayer;
                            }
                            
                            parkLayers[layerInfo.id] = {
                                layer: layer,
                                heatmapLayer: heatmapLayer,
                                markerLayer: markerLayer,
                                name: layerInfo.name,
                                visible: false
                            };
                            return layerInfo;
                        }
                        else {
                            layer = L.geoJSON(data, {
                                style: function(feature) {
                                    // Only apply style for non-point features
                                    if (feature.geometry.type !== 'Point') {
                                        return getStyleForFile(layerInfo.id, feature);
                                    }
                                },
                                pointToLayer: function(feature, latlng) {
                                    if (layerInfo.id === 'vga' && feature.properties && feature.properties.visibility_pct !== undefined) {
                                        console.log(`VGA point styled with visibility: ${feature.properties.visibility_pct}`);
                                        return getVGAPointStyle(feature, latlng);
                                    }
                                    return getPointStyleForFile(layerInfo.id, latlng);
                                },
                                onEachFeature: function(feature, layer) {
                                    if (layerInfo.id === 'park-features' && feature.properties && feature.properties['Park Feature']) {
                                        const featureName = feature.properties['Park Feature'];
                                        parkFeaturesPresent.add(featureName);
                                        
                                        layer.bindPopup(featureName);
                                        layer.bindTooltip(featureName, {
                                            permanent: false,
                                            direction: 'top',
                                            className: 'feature-tooltip',
                                            offset: [0, -10]
                                        });
                                        
                                        // Apply styling based on feature type
                                        const style = getParkFeatureStyle(featureName);
                                        if (layer.setStyle) {
                                            layer.setStyle(style);
                                        }
                                    }
                                    
                                    // Handle entrances - display Source field in title case
                                    if (layerInfo.id === 'entrances' && feature.properties && feature.properties['source']) {
                                        const sourceText = feature.properties['source'];
                                        // Convert to title case
                                        const titleCaseText = sourceText.charAt(0).toUpperCase() + sourceText.slice(1).toLowerCase();
                                        
                                        layer.bindPopup(titleCaseText);
                                        layer.bindTooltip(titleCaseText, {
                                            permanent: false,
                                            direction: 'top',
                                            className: 'feature-tooltip',
                                            offset: [0, -10]
                                        });
                                    }
                                    
                                    // Handle park-boundary - add hover and click effects to show Park Name
                                    if (layerInfo.id === 'park-boundary' && feature.properties && feature.properties['Park Name']) {
                                        const parkName = feature.properties['Park Name'];
                                        
                                        layer.bindTooltip(parkName, {
                                            permanent: false,
                                            direction: 'center',
                                            className: 'park-boundary-tooltip',
                                            offset: [0, 0]
                                        });
                                        
                                        layer.on('mouseover', function() {
                                            layer.openTooltip();
                                            console.log(`Hovering over: ${parkName}`);
                                        });
                                        
                                        layer.on('mouseout', function() {
                                            layer.closeTooltip();
                                        });
                                        
                                        layer.on('click', function() {
                                            console.log(`Clicked on: ${parkName}`);
                                        });
                                    }
                                }
                            });
                        }
                        
                        // Only add park-boundary to map by default
                        if (layerInfo.id === 'park-boundary') {
                            layer.addTo(map);
                        }
                        
                        parkLayers[layerInfo.id] = {
                            layer: layer,
                            name: layerInfo.name,
                            visible: (layerInfo.id === 'park-boundary')
                        };
                        return layerInfo;
                    }
                }
                return null;
            })
            .catch(error => {
                console.error(`Error loading ${layerInfo.id} (${layerInfo.file}):`, error);
                return null;
            });
    });
    
    // After all layers are loaded, populate toggles and legend
    Promise.all(loadPromises).then(results => {
        const loadedLayers = results.filter(r => r !== null);
        
        // Add demographics layer from the new dataset if available for this park
        if (useParkDemographicsDataset && parkDemographicsData) {
            const parkFeature = parkDemographicsData.features.find(
                feature => feature.properties && feature.properties['Primary Name'] === parkName
            );
            
            if (parkFeature) {
                console.log(`Adding demographics layer from park-specific dataset for ${parkName}`);
                
                // Transform the geometry from EPSG:27700 to WGS84
                const transformedFeature = {
                    ...parkFeature,
                    geometry: transformGeometry(parkFeature.geometry)
                };
                
                const data = {
                    type: 'FeatureCollection',
                    features: [transformedFeature]
                };
                
                const layer = L.geoJSON(data, {
                    style: function(feature) {
                        if (feature.geometry.type !== 'Point') {
                            return getStyleForFile('demographics', feature);
                        }
                    },
                    pointToLayer: function(feature, latlng) {
                        return getPointStyleForFile('demographics', latlng);
                    }
                });
                
                parkLayers['demographics'] = {
                    layer: layer,
                    name: 'Demographics Data',
                    visible: false
                };
                
                // Populate the demographics table with data from park_level_demographic_summary_symbol
                if (parkFeature.properties && parkFeature.properties.park_level_demographic_summary_symbol) {
                    populateDemographicsTable(parkFeature.properties.park_level_demographic_summary_symbol);
                }
                
                // Add to loaded layers list
                loadedLayers.push({
                    id: 'demographics',
                    name: 'Demographics Data',
                    file: 'park_demographics_dataset'
                });
            }
        }
        
        populateDataLayerToggles(loadedLayers);
        populateDataLayersLegend(loadedLayers);
    });
}

// Populate data layer toggle switches
function populateDataLayerToggles(layers) {
    const container = document.getElementById('dataLayerToggles');
    container.innerHTML = '';
    
    layers.forEach(layerInfo => {
        const li = document.createElement('li');
        li.className = 'toggle-switch';
        
        const label = document.createElement('label');
        label.className = 'toggle-label';
        
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = `toggle-${layerInfo.id}`;
        input.checked = (layerInfo.id === 'park-boundary');
        input.setAttribute('role', 'switch');
        input.setAttribute('aria-label', `Toggle ${layerInfo.name} layer`);
        
        const span = document.createElement('span');
        span.textContent = layerInfo.name;
        
        input.addEventListener('change', function() {
            toggleDataLayer(layerInfo.id, this.checked);
        });
        
        label.appendChild(input);
        label.appendChild(span);
        li.appendChild(label);
        container.appendChild(li);
    });
}

// Populate demographics table in the modal
function populateDemographicsTable(demographicData) {
    const container = document.getElementById('demographicsTableContainer');
    if (!container) return;
    
    if (!demographicData) {
        container.innerHTML = '<p><em>No demographic data available for this park.</em></p>';
        return;
    }
    
    // Split the data by line breaks
    const lines = demographicData.split('\n').filter(line => line.trim());
    
    if (lines.length === 0) {
        container.innerHTML = '<p><em>No demographic data available for this park.</em></p>';
        return;
    }
    
    // Create table
    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.marginTop = '1rem';
    
    // Create table header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const th1 = document.createElement('th');
    th1.textContent = 'Demographic Variable';
    th1.style.textAlign = 'left';
    th1.style.padding = '0.5rem';
    th1.style.borderBottom = '2px solid var(--pico-primary)';
    const th2 = document.createElement('th');
    th2.textContent = 'Value';
    th2.style.textAlign = 'right';
    th2.style.padding = '0.5rem';
    th2.style.borderBottom = '2px solid var(--pico-primary)';
    headerRow.appendChild(th1);
    headerRow.appendChild(th2);
    thead.appendChild(headerRow);
    table.appendChild(thead);
    
    // Create table body
    const tbody = document.createElement('tbody');
    
    lines.forEach((line, index) => {
        // Split on the last occurrence of "N=" to separate label from value
        const lastNIndex = line.lastIndexOf('N=');
        if (lastNIndex === -1) return; // Skip if no "N=" found
        
        const label = line.substring(0, lastNIndex).trim();
        const value = 'N=' + line.substring(lastNIndex + 2).trim();
        
        const row = document.createElement('tr');
        
        const td1 = document.createElement('td');
        td1.textContent = label;
        td1.style.padding = '0.5rem';
        td1.style.borderBottom = '1px solid var(--pico-muted-border-color)';
        
        const td2 = document.createElement('td');
        td2.textContent = value;
        td2.style.textAlign = 'right';
        td2.style.padding = '0.5rem';
        td2.style.borderBottom = '1px solid var(--pico-muted-border-color)';
        td2.style.fontFamily = 'monospace';
        
        row.appendChild(td1);
        row.appendChild(td2);
        tbody.appendChild(row);
        
        // Alternate row colors
        if (index % 2 === 1) {
            row.style.backgroundColor = 'var(--pico-background-color)';
        }
    });
    
    table.appendChild(tbody);
    container.innerHTML = '';
    container.appendChild(table);
}

// Toggle data layer visibility
function toggleDataLayer(layerId, visible) {
    const layerObj = parkLayers[layerId];
    if (!layerObj) return;
    
    if (visible) {
        layerObj.layer.addTo(map);
    } else {
        map.removeLayer(layerObj.layer);
    }
    
    layerObj.visible = visible;
    
    const legendItem = document.querySelector(`[data-layer-id="${layerId}"]`);
    if (legendItem) {
        legendItem.style.display = visible ? 'flex' : 'none';
    }
    
    if (layerId === 'roads') {
        const colorbar = document.querySelector('[data-layer-id="roads-colorbar"]');
        if (colorbar) {
            colorbar.style.display = visible ? 'block' : 'none';
        }
    }
    
    if (layerId === 'vga') {
        const colorbar = document.querySelector('[data-layer-id="vga-colorbar"]');
        if (colorbar) {
            colorbar.style.display = visible ? 'block' : 'none';
        }
    }
}

// Populate data layers legend
function populateDataLayersLegend(layers) {
    const legendContainer = document.getElementById('dataLayersLegend');
    
    if (layers.length === 0) {
        legendContainer.style.display = 'none';
        return;
    }
    
    legendContainer.style.display = 'block';
    legendContainer.innerHTML = '<h3>Data Layers</h3>';
    
    layers.forEach(layerInfo => {
        const legendItem = document.createElement('div');
        legendItem.className = 'legend-item';
        legendItem.setAttribute('data-layer-id', layerInfo.id);
        
        // Set initial visibility based on layer visibility
        const layerObj = parkLayers[layerInfo.id];
        if (layerObj && !layerObj.visible) {
            legendItem.style.display = 'none';
        }
        
        const symbol = getLegendSymbol(layerInfo.id);
        
        // Make label clickable to open info modal
        const label = document.createElement('a');
        label.href = '#';
        label.className = 'legend-label legend-label-link';
        label.textContent = layerInfo.name;
        label.title = `Click for more information about ${layerInfo.name}`;
        label.addEventListener('click', function(e) {
            e.preventDefault();
            openLayerInfoModal(layerInfo.id);
        });
        
        legendItem.appendChild(symbol);
        legendItem.appendChild(label);
        
        // Add expand button for park-features
        if (layerInfo.id === 'park-features') {
            const expandBtn = document.createElement('span');
            expandBtn.textContent = '+';
            expandBtn.style.marginLeft = 'auto';
            expandBtn.style.cursor = 'pointer';
            expandBtn.style.fontSize = '1.2rem';
            expandBtn.style.fontWeight = 'bold';
            expandBtn.style.userSelect = 'none';
            expandBtn.style.padding = '0 0.5rem';
            legendItem.style.display = 'flex';
            legendItem.style.alignItems = 'center';
            legendItem.appendChild(expandBtn);
        }
        
        legendContainer.appendChild(legendItem);
        
        if (layerInfo.id === 'roads') {
            const colorbarContainer = document.createElement('div');
            colorbarContainer.className = 'legend-colorbar-container';
            colorbarContainer.setAttribute('data-layer-id', 'roads-colorbar');
            
            // Hide colorbar if roads layer is not visible
            const layerObj = parkLayers[layerInfo.id];
            if (layerObj && !layerObj.visible) {
                colorbarContainer.style.display = 'none';
            }
            
            colorbarContainer.innerHTML = `
                <div class="legend-colorbar">
                    <svg width="100%" height="20" preserveAspectRatio="none" viewBox="0 0 200 20">
                        <defs>
                            <linearGradient id="turboGradientFull" x1="0%" y1="0%" x2="100%" y2="0%">
                                <stop offset="0%" style="stop-color:rgb(48,18,59);stop-opacity:1" />
                                <stop offset="12.5%" style="stop-color:rgb(62,73,137);stop-opacity:1" />
                                <stop offset="25%" style="stop-color:rgb(62,125,224);stop-opacity:1" />
                                <stop offset="37.5%" style="stop-color:rgb(33,180,180);stop-opacity:1" />
                                <stop offset="50%" style="stop-color:rgb(33,200,132);stop-opacity:1" />
                                <stop offset="62.5%" style="stop-color:rgb(122,209,81);stop-opacity:1" />
                                <stop offset="75%" style="stop-color:rgb(253,231,37);stop-opacity:1" />
                                <stop offset="87.5%" style="stop-color:rgb(239,121,21);stop-opacity:1" />
                                <stop offset="100%" style="stop-color:rgb(180,4,38);stop-opacity:1" />
                            </linearGradient>
                        </defs>
                        <rect x="0" y="0" width="200" height="20" fill="url(#turboGradientFull)" stroke="#333" stroke-width="1"/>
                    </svg>
                </div>
                <div class="legend-colorbar-labels">
                    <span>Less Busy</span>
                    <span>Busier</span>
                </div>
            `;
            legendContainer.appendChild(colorbarContainer);
        }
        
        if (layerInfo.id === 'vga') {
            const colorbarContainer = document.createElement('div');
            colorbarContainer.className = 'legend-colorbar-container';
            colorbarContainer.setAttribute('data-layer-id', 'vga-colorbar');
            
            // Hide colorbar if VGA layer is not visible
            const layerObj = parkLayers[layerInfo.id];
            if (layerObj && !layerObj.visible) {
                colorbarContainer.style.display = 'none';
            }
            
            colorbarContainer.innerHTML = `
                <div class="legend-colorbar">
                    <svg width="100%" height="20" preserveAspectRatio="none" viewBox="0 0 200 20">
                        <defs>
                            <linearGradient id="viridisGradientFull" x1="0%" y1="0%" x2="100%" y2="0%">
                                <stop offset="0%" style="stop-color:rgb(68,1,84);stop-opacity:1" />
                                <stop offset="14.3%" style="stop-color:rgb(70,50,127);stop-opacity:1" />
                                <stop offset="28.6%" style="stop-color:rgb(54,92,141);stop-opacity:1" />
                                <stop offset="42.9%" style="stop-color:rgb(37,130,142);stop-opacity:1" />
                                <stop offset="57.2%" style="stop-color:rgb(29,165,122);stop-opacity:1" />
                                <stop offset="71.4%" style="stop-color:rgb(68,191,78);stop-opacity:1" />
                                <stop offset="85.7%" style="stop-color:rgb(154,213,42);stop-opacity:1" />
                                <stop offset="100%" style="stop-color:rgb(253,231,37);stop-opacity:1" />
                            </linearGradient>
                        </defs>
                        <rect x="0" y="0" width="200" height="20" fill="url(#viridisGradientFull)" stroke="#333" stroke-width="1"/>
                    </svg>
                </div>
                <div class="legend-colorbar-labels">
                    <span>Low Visibility</span>
                    <span>High Visibility</span>
                </div>
            `;
            legendContainer.appendChild(colorbarContainer);
        }
        
        if (layerInfo.id === 'park-features') {
            // Find the expand button we just created
            const expandBtn = legendItem.querySelector('span');
            
            // Create the categories container (hidden by default)
            const featuresContainer = document.createElement('div');
            featuresContainer.className = 'legend-features-subcategories';
            featuresContainer.setAttribute('data-layer-id', 'park-features-categories');
            featuresContainer.style.display = 'none';
            featuresContainer.style.marginTop = '0.5rem';
            featuresContainer.style.marginLeft = '1rem';
            
            // Helper function to check if a feature type exists in the data
            const featureTypeExists = (featureName, checkStrings) => {
                return Array.from(parkFeaturesPresent).some(feature => 
                    checkStrings.some(str => feature.toLowerCase().includes(str))
                );
            };
            
            // Only show categories that actually exist in the data
            const categories = [];
            
            if (featureTypeExists('garden', ['garden'])) {
                categories.push({ name: 'Garden', fill: '#90EE90', stroke: '#2D8D2D', dash: '5,5' });
            }
            if (featureTypeExists('pitch', ['pitch', 'track', 'sports centre'])) {
                categories.push({ name: 'Pitch / Track / Sports Centre', fill: '#714a6d', stroke: '#4A2A47', dash: '10,5' });
            }
            if (featureTypeExists('parking', ['parking'])) {
                categories.push({ name: 'Parking', fill: '#3388ff', stroke: '#1a5cc4', dash: 'none' });
            }
            if (featureTypeExists('monument', ['monument'])) {
                categories.push({ name: 'Monument', fill: '#999999', stroke: '#4d4d4d', dash: 'none' });
            }
            if (featureTypeExists('cafe', ['cafe', 'coffee'])) {
                categories.push({ name: 'Cafe', fill: '#FF9800', stroke: '#E65100', dash: 'none' });
            }
            if (featureTypeExists('toilet', ['toilet', 'wc'])) {
                categories.push({ name: 'Toilet', fill: '#068D9D', stroke: '#043F4B', dash: 'none' });
            }
            
            // Add "Other" category if there are any features not already categorized
            if (parkFeaturesPresent.size > 0) {
                const allCategorized = Array.from(parkFeaturesPresent).every(feature => {
                    const fname = feature.toLowerCase();
                    return fname.includes('garden') || fname.includes('pitch') || fname.includes('track') || 
                           fname.includes('sports centre') || fname.includes('parking') || fname.includes('monument') || 
                           fname.includes('cafe') || fname.includes('coffee') || fname.includes('toilet') || fname.includes('wc');
                });
                if (!allCategorized) {
                    categories.push({ name: 'Other', fill: '#E87EA1', stroke: '#B85A7A', dash: 'none' });
                }
            }
            
            categories.forEach(cat => {
                const subItem = document.createElement('div');
                subItem.className = 'legend-subitem';
                subItem.style.marginLeft = '1rem';
                subItem.style.marginTop = '0.5rem';
                subItem.style.display = 'flex';
                subItem.style.alignItems = 'center';
                
                const symbol = document.createElement('div');
                symbol.className = 'legend-marker';
                symbol.style.marginRight = '0.5rem';
                symbol.style.minWidth = '24px';
                
                const dashStyle = cat.dash === 'none' ? '' : `stroke-dasharray="${cat.dash}"`;
                symbol.innerHTML = `<svg width="24" height="24"><rect x="4" y="4" width="16" height="16" fill="${cat.fill}" stroke="${cat.stroke}" stroke-width="2" ${dashStyle}/></svg>`;
                
                const label = document.createElement('span');
                label.textContent = cat.name;
                label.style.fontSize = '0.9rem';
                
                subItem.appendChild(symbol);
                subItem.appendChild(label);
                featuresContainer.appendChild(subItem);
            });
            
            // Add click handler to toggle visibility
            expandBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (featuresContainer.style.display === 'none') {
                    featuresContainer.style.display = 'block';
                    expandBtn.textContent = '−';
                } else {
                    featuresContainer.style.display = 'none';
                    expandBtn.textContent = '+';
                }
            });
            
            legendContainer.appendChild(featuresContainer);
        }
    });
}

// Get legend symbol for each layer type
function getLegendSymbol(layerId) {
    const marker = document.createElement('div');
    marker.className = 'legend-marker';
    
    switch(layerId) {
        case 'park-boundary':
            marker.innerHTML = '<svg width="20" height="20"><rect x="2" y="2" width="16" height="16" fill="rgba(49, 163, 84, 0.1)" stroke="#31a354" stroke-width="2"/></svg>';
            break;
        case 'park-features':
            marker.innerHTML = '<svg width="20" height="20"><rect x="4" y="4" width="12" height="12" fill="#cccccc" stroke="#666" stroke-width="1"/></svg>';
            break;
        case 'trees':
            marker.innerHTML = '<svg width="20" height="20"><circle cx="10" cy="10" r="5" fill="#22c55e" stroke="#fff" stroke-width="1.5"/></svg>';
            break;
        case 'benches':
            marker.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="3" width="16" height="2" fill="#a0826d"/><rect x="2" y="6" width="16" height="2" fill="#a0826d"/><rect x="4" y="8" width="1.5" height="5" fill="#a0826d"/><rect x="14.5" y="8" width="1.5" height="5" fill="#a0826d"/><rect x="9" y="9" width="1" height="4" fill="#a0826d"/></svg>';
            break;
        case 'roads':
            marker.innerHTML = '<svg width="20" height="20"><defs><linearGradient id="turboGradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:rgb(48,18,59);stop-opacity:1" /><stop offset="25%" style="stop-color:rgb(62,125,224);stop-opacity:1" /><stop offset="50%" style="stop-color:rgb(33,200,132);stop-opacity:1" /><stop offset="75%" style="stop-color:rgb(253,231,37);stop-opacity:1" /><stop offset="100%" style="stop-color:rgb(180,4,38);stop-opacity:1" /></linearGradient></defs><rect x="2" y="8" width="16" height="4" fill="url(#turboGradient)" stroke="#333" stroke-width="0.5"/></svg>';
            break;
        case 'lighting':
            marker.innerHTML = '<svg width="20" height="20"><defs><radialGradient id="heatGradient"><stop offset="0%" style="stop-color:rgba(255,255,0,0.8);stop-opacity:1" /><stop offset="50%" style="stop-color:rgba(255,165,0,0.5);stop-opacity:1" /><stop offset="100%" style="stop-color:rgba(0,0,255,0.1);stop-opacity:0" /></radialGradient></defs><circle cx="10" cy="10" r="8" fill="url(#heatGradient)"/></svg>';
            break;
        case 'entrances':
            marker.innerHTML = '<svg width="20" height="20"><circle cx="10" cy="10" r="6" fill="#10b981" stroke="#fff" stroke-width="1.5"/></svg>';
            break;
        case 'buffer':
            marker.innerHTML = '<svg width="20" height="20"><rect x="2" y="2" width="16" height="16" fill="none" stroke="#9ca3af" stroke-width="2" stroke-dasharray="3,3"/></svg>';
            break;
        case 'demographics':
            marker.innerHTML = '<svg width="20" height="20"><rect x="2" y="2" width="16" height="16" fill="none" stroke="#3b82f6" stroke-width="3" stroke-dasharray="6,3"/></svg>';
            break;
        case 'vga':
            marker.innerHTML = '<svg width="20" height="20"><defs><linearGradient id="viridisGradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:rgb(68,1,84);stop-opacity:1" /><stop offset="25%" style="stop-color:rgb(54,92,141);stop-opacity:1" /><stop offset="50%" style="stop-color:rgb(37,130,142);stop-opacity:1" /><stop offset="75%" style="stop-color:rgb(68,191,78);stop-opacity:1" /><stop offset="100%" style="stop-color:rgb(253,231,37);stop-opacity:1" /></linearGradient></defs><rect x="2" y="8" width="16" height="4" fill="url(#viridisGradient)" stroke="#333" stroke-width="0.5"/></svg>';
            break;
        default:
            marker.innerHTML = '<svg width="20" height="20"><circle cx="10" cy="10" r="6" fill="#714a6d" stroke="#fff" stroke-width="1"/></svg>';
    }
    
    return marker;
}

// Google Turbo colormap implementation
function turboColormap(t) {
    t = Math.max(0, Math.min(1, t));
    
    const kRedVec4 = [0.13572138, 4.61539260, -42.66032258, 132.13108234];
    const kGreenVec4 = [0.09140261, 2.19418839, 4.84296658, -14.18503333];
    const kBlueVec4 = [0.10667330, 12.64194608, -60.58204836, 110.36276771];
    const kRedVec2 = [-152.94239396, 59.28637943];
    const kGreenVec2 = [4.27729857, 2.82956604];
    const kBlueVec2 = [-89.90310912, 27.34824973];
    
    const v4 = [1.0, t, t * t, t * t * t];
    const v2 = [v4[2] * v4[2], v4[3] * v4[2]];
    
    let r = kRedVec4[0] * v4[0] + kRedVec4[1] * v4[1] + kRedVec4[2] * v4[2] + kRedVec4[3] * v4[3] + kRedVec2[0] * v2[0] + kRedVec2[1] * v2[1];
    let g = kGreenVec4[0] * v4[0] + kGreenVec4[1] * v4[1] + kGreenVec4[2] * v4[2] + kGreenVec4[3] * v4[3] + kGreenVec2[0] * v2[0] + kGreenVec2[1] * v2[1];
    let b = kBlueVec4[0] * v4[0] + kBlueVec4[1] * v4[1] + kBlueVec4[2] * v4[2] + kBlueVec4[3] * v4[3] + kBlueVec2[0] * v2[0] + kBlueVec2[1] * v2[1];
    
    r = Math.round(Math.max(0, Math.min(1, r)) * 255);
    g = Math.round(Math.max(0, Math.min(1, g)) * 255);
    b = Math.round(Math.max(0, Math.min(1, b)) * 255);
    
    return `rgb(${r}, ${g}, ${b})`;
}

// Convert British National Grid coordinates to WGS84 latitude/longitude
// Simple approximation for UK (sufficient accuracy for mapping)


// Helper function to sanitize park names to folder names (matching Python sanitization)
function sanitizeForFolder(name) {
    name = String(name).trim();
    // Remove all non-alphanumeric characters except spaces and underscores
    name = name.replace(/[^A-Za-z0-9 _]/g, '');
    // Replace whitespace with underscores
    name = name.replace(/\s+/g, '_');
    // Collapse multiple consecutive underscores
    name = name.replace(/_+/g, '_');
    // Title case each word
    name = name.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join('_');
    return name;
}

// Helper function to extract folder names from HTML directory listing
function extractFolderNamesFromHtml(html) {
    const folders = [];
    const regex = /href="([^"]+)\//g;
    let match;
    while ((match = regex.exec(html)) !== null) {
        let folder = match[1];
        // Filter out parent directory and common non-folder entries
        if (folder !== '..' && folder !== '.') {
            // Extract just the folder name from the path (last part after /)
            folder = folder.split('/').pop();
            folders.push(folder);
        }
    }
    return folders;
}

// Helper function to get styling for park features based on their type
function getParkFeatureStyle(featureName) {
    if (!featureName) {
        return { 
            fillColor: '#E87EA1', 
            color: '#C2527A', // Darker outline
            weight: 2, 
            fillOpacity: 0.8,
            dashArray: null 
        };
    }
    
    const name = featureName.toLowerCase();
    
    // Garden
    if (name.includes('garden')) {
        return { 
            fillColor: '#90EE90', 
            color: '#2D8D2D', // Darker green outline
            weight: 2, 
            fillOpacity: 0.8,
            dashArray: '5,5' 
        };
    }
    
    // Pitch, Track, Sports Centre
    if (name.includes('pitch') || name.includes('track') || name.includes('sports centre')) {
        return { 
            fillColor: '#714a6d', 
            color: '#4A2A47', // Darker purple outline
            weight: 2, 
            fillOpacity: 0.8,
            dashArray: '10,5' 
        };
    }
    
    // Parking
    if (name.includes('parking')) {
        return { 
            fillColor: '#3388ff', 
            color: '#1a5cc4', // Darker blue outline
            weight: 2, 
            fillOpacity: 0.8,
            dashArray: null 
        };
    }
    
    // Monuments
    if (name.includes('monument')) {
        return { 
            fillColor: '#999999', 
            color: '#4d4d4d', // Darker grey outline
            weight: 2, 
            fillOpacity: 0.8,
            dashArray: null 
        };
    }
    
    // Cafes
    if (name.includes('cafe') || name.includes('coffee')) {
        return { 
            fillColor: '#FF9800', 
            color: '#E65100', // Darker orange outline
            weight: 2, 
            fillOpacity: 0.8,
            dashArray: null 
        };
    }
    
    // Toilets
    if (name.includes('toilet') || name.includes('wc')) {
        return { 
            fillColor: '#068D9D', 
            color: '#043F4B', // Darker teal outline
            weight: 2, 
            fillOpacity: 0.8,
            dashArray: null 
        };
    }
    
    // Others - cycle through colors
    const otherColors = [
        { fill: '#E87EA1', stroke: '#B85A7A' },
        { fill: '#CB904D', stroke: '#8B6230' },
        { fill: '#6D9DC5', stroke: '#445A7F' }
    ];
    const colorIndex = featureName.charCodeAt(0) % otherColors.length;
    const colorPair = otherColors[colorIndex];
    return { 
        fillColor: colorPair.fill, 
        color: colorPair.stroke, 
        weight: 2, 
        fillOpacity: 0.8,
        dashArray: null 
    };
}

function getStyleForFile(layerId, feature) {
    switch(layerId) {
        case 'roads':
            let segmentValue = 0.5;
            if (feature && feature.properties) {
                const value = feature.properties.NACh_calculated;
                
                if (value !== undefined && value !== null) {
                    const minVal = roadSegmentRange.min;
                    const maxVal = roadSegmentRange.max;
                    segmentValue = maxVal > minVal ? (value - minVal) / (maxVal - minVal) : 0.5;
                }
            }
            
            const color = turboColormap(segmentValue);
            return { color: color, weight: 3, opacity: 0.8 };
        case 'park-boundary':
            // Check if this is a pocket park (< 4000 m²)
            const parkArea = feature && feature.properties && feature.properties['Total Area (m²)'];
            if (parkArea !== undefined && parkArea !== null && parkArea < 4000) {
                // Pocket parks: dashed dark purple line
                return { color: '#714a6d', weight: 2, fillOpacity: 0.1, dashArray: '5,5' };
            } else {
                // Regular parks: green line
                return { color: '#31a354', weight: 2, fillOpacity: 0.1 };
            }
        case 'park-features':
            return { color: '#714a6d', weight: 2, fillColor: '#714a6d', fillOpacity: 0.3, opacity: 0.7 };
        case 'buffer':
            return { color: '#9ca3af', weight: 2, fillOpacity: 0.05, dashArray: '5,5' };
        case 'demographics':
            return { color: '#3b82f6', weight: 4, fillOpacity: 0, opacity: 0.9, dashArray: '10,5' };
        case 'vga':
            return { color: '#f59e0b', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.2, opacity: 0.7 };
        case 'entrances':
            return { color: '#10b981', weight: 2, fillColor: '#10b981', fillOpacity: 0.3 };
        case 'trees':
            return { color: '#22c55e', weight: 6, opacity: 1.0, lineCap: 'round', lineJoin: 'round' };
        default:
            return { color: '#714a6d', weight: 2, opacity: 0.7 };
    }
}

// Viridis colormap implementation (scientific colormap)
function viridisColormap(t) {
    t = Math.max(0, Math.min(1, t));
    
    // Viridis colormap lookup table (8 key points)
    const colors = [
        {t: 0.0, r: 68, g: 1, b: 84},
        {t: 0.143, r: 70, g: 50, b: 127},
        {t: 0.286, r: 54, g: 92, b: 141},
        {t: 0.429, r: 37, g: 130, b: 142},
        {t: 0.571, r: 29, g: 165, b: 122},
        {t: 0.714, r: 68, g: 191, b: 78},
        {t: 0.857, r: 154, g: 213, b: 42},
        {t: 1.0, r: 253, g: 231, b: 37}
    ];
    
    let color1, color2;
    for (let i = 0; i < colors.length - 1; i++) {
        if (t >= colors[i].t && t <= colors[i+1].t) {
            color1 = colors[i];
            color2 = colors[i+1];
            break;
        }
    }
    
    if (!color1 || !color2) {
        color1 = colors[0];
        color2 = colors[colors.length - 1];
    }
    
    // Linear interpolation between colors
    const range = color2.t - color1.t;
    const localT = range > 0 ? (t - color1.t) / range : 0;
    
    const r = Math.round(color1.r + (color2.r - color1.r) * localT);
    const g = Math.round(color1.g + (color2.g - color1.g) * localT);
    const b = Math.round(color1.b + (color2.b - color1.b) * localT);
    
    return `rgb(${r}, ${g}, ${b})`;
}

// Get styling for VGA points based on visibility_pct
function getVGAPointStyle(feature, latlng) {
    let visibilityValue = 0.5;
    
    if (feature && feature.properties && feature.properties.visibility_pct !== undefined) {
        const value = Number(feature.properties.visibility_pct);
        const minVal = vgaVisibilityRange.min;
        const maxVal = vgaVisibilityRange.max;
        visibilityValue = maxVal > minVal ? (value - minVal) / (maxVal - minVal) : 0.5;
    }
    
    const color = viridisColormap(visibilityValue);
    console.log(`VGA color for normalized ${visibilityValue}: ${color}, range: ${vgaVisibilityRange.min}-${vgaVisibilityRange.max}`);
    
    return L.circleMarker(latlng, {
        radius: 5,
        fillColor: color,
        color: '#fff',
        weight: 1,
        opacity: 1,
        fillOpacity: 0.8
    });
}

// Get point styling for different layer types
function getPointStyleForFile(layerId, latlng) {
    let color = '#714a6d';
    let radius = 6;
    let linecolor = '#fff';
    let weight = 1;
    let dashArray = null;
    
    switch(layerId) {
        case 'park-features':
            // This will be handled in onEachFeature for proper feature-based styling
            color = '#8B4513';
            radius = 6;
            weight = 1;
            break;
        case 'lighting':
            linecolor = '#ffa60087';
            color = '#ffff19ab';
            radius = 4;
            weight = 2;
            break;
        case 'entrances':
            color = '#10b981';
            radius = 5;
            weight = 2;
            break;
        case 'trees':
            color = '#22c55e';
            radius = 5;
            weight = 1;
            break;
        case 'benches':
            // Return custom SVG marker for benches (OSM-style)
            const benchIcon = L.divIcon({
                html: '<svg width="28" height="28" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="3" width="16" height="2" fill="#a0826d"/><rect x="2" y="6" width="16" height="2" fill="#a0826d"/><rect x="4" y="8" width="1.5" height="5" fill="#a0826d"/><rect x="14.5" y="8" width="1.5" height="5" fill="#a0826d"/><rect x="9" y="9" width="1" height="4" fill="#a0826d"/></svg>',
                iconSize: [28, 28],
                className: 'bench-marker'
            });
            return L.marker(latlng, { icon: benchIcon });
        default:
            break;
    }
    
    return L.circleMarker(latlng, {
        radius: radius,
        fillColor: color,
        color: linecolor,
        weight: weight,
        opacity: 1,
        fillOpacity: 0.8,
        dashArray: dashArray
    });
}

function populateParksDropdown(data) {
    parksSelect.innerHTML = '<option value="">-- Select a park --</option>';
    
    const validParks = data.features
        .filter(feature => feature.geometry !== null && feature.properties['Park Name'])
        .sort((a, b) => a.properties['Park Name'].localeCompare(b.properties['Park Name']));
    
    // Deduplicate by park name
    const seenParks = new Set();
    validParks.forEach(feature => {
        const parkName = feature.properties['Park Name'];
        if (!seenParks.has(parkName)) {
            seenParks.add(parkName);
            const option = document.createElement('option');
            option.value = parkName;
            option.textContent = parkName;
            parksSelect.appendChild(option);
        }
    });
    
    parksSelect.addEventListener('change', function() {
        loadParkBtn.disabled = !this.value;
    });
}

loadParkBtn.addEventListener('click', function() {
    const selectedPark = parksSelect.value;
    
    if (!selectedPark) {
        alert('Please select a park first');
        return;
    }
    
    loadParkData(selectedPark);
});

L.control.scale({
    position: 'bottomleft',
    metric: true,
    imperial: false,
    maxWidth: 150
}).addTo(map);

// NOW add URL parameter checking AFTER modal functions are defined
document.addEventListener('DOMContentLoaded', function() {
    // Initialize LAD dropdown by discovering folders
    initializeLADropdown();
    
    const urlParams = new URLSearchParams(window.location.search);
    const modalParam = urlParams.get('modal');
    
    setTimeout(() => {
        if (modalParam === 'la') {
            openLAModal();
        } else if (modalParam === 'policing') {
            openPolicingModal();
        } else if (modalParam === 'guide') {
            openControlsModal();
        }
        // Note: controls guide no longer opens automatically
    }, 500);
});