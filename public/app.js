// app.js

// Global variables
let map, markerGroups;
const markers = {};
let allMarkers = {}; // Store all markers for filtering
let timeRangeHours; // Time range from config
let currentMapMode = 'day'; // Possible values: 'day', 'night', 'satellite'
let dayLayer, nightLayer, satelliteLayer; // Declare layers globally
let socket; // Socket.IO
let currentSearchTerm = ''; // Current search term
const wavesurfers = {}; // Store WaveSurfer instances
let audioContext = null; // Initialize explicitly as null
let heatmapLayer; // Heatmap layer
let heatmapIntensity; // Intensity for heatmap
let toggleModeButton; // Button to toggle map modes
let liveAudioStream = null;
let isLiveStreamPlaying = false;
let audioContainer = null;
let currentSessionToken = null;
let selectedCategory = null;
let timestampUpdateInterval = null;
let isNewCallAudioMuted = false;
let isTrackingNewCalls = true; // Default to true so tracking is enabled by defaultlet additionalWavesurfers = {};
const talkgroupPageLimit = 30; // How many calls to fetch per page
let currentTalkgroupOffset = 0;
let isLoadingMoreTalkgroupCalls = false;
let hasMoreTalkgroupCalls = true;
let isSearchingForTargetCall = false; // NEW: State for target search
let isAdminUser = false; // NEW: Track admin status
let authEnabled = false; // NEW: Track if authentication is enabled

const USER_LOCATION_ZOOM_LEVEL = 16; // ENSURE THIS GLOBAL CONSTANT IS DECLARED

// NEW: Variables for Talkgroup Modal
let isTalkgroupModalOpen = false;
let currentOpenTalkgroupId = null;
const talkgroupModalWavesurfers = {}; // Separate WaveSurfer instances for the modal
let talkgroupPollingInterval = null; // Interval ID for polling
let talkgroupModalAutoplay = true; // Default autoplay to true
let lastCallTimestampInModal = null; // Track the newest timestamp shown in modal

// NEW: Global Volume Level
let globalVolumeLevel = 0.5; // Default to 50% volume

// NEW: Variable to store original mute state
let originalMuteStateBeforeModal = false;

// --- Live Feed State Variables ---
let liveFeedSelectedTalkgroups = new Set(); // Stores IDs of selected talkgroups
// REMOVED: let isLiveFeedEnabled = false;
let isLiveFeedAudioEnabled = false;
let allLiveFeedTalkgroups = []; // Cache for the full talkgroup list
const MAX_LIVE_FEED_ITEMS = 5;
const LIVE_FEED_ITEM_DURATION = 15000; // 15 seconds in milliseconds
const LIVE_FEED_RETRY_INTERVAL = 3000; // 3 seconds for retry
const MAX_LIVE_FEED_RETRIES = 5; // Max 5 retries (total 15 seconds)

// Performance optimization variables
let liveFeedSearchDebounceTimer = null;
const LIVE_FEED_SEARCH_DEBOUNCE_DELAY = 300; // 300ms debounce
const MAX_TALKGROUPS_DISPLAY = 100; // Limit displayed talkgroups for performance

// Add references for the UI elements that will be assigned in setupLiveFeed
// REMOVED liveFeedEnableCheckbox
let liveFeedModal, liveFeedSetupBtn, liveFeedSearchInput, liveFeedAudioEnableCheckbox, liveFeedTalkgroupListContainer, liveFeedDisplayContainer;

// Declare the audio source variable globally if it doesn't exist elsewhere
let currentAudioSource = null;
// --- End Live Feed State Variables ---

// MOVED TO TOP: initGlobalGainNode definition
function initGlobalGainNode() {
    console.log("[VOLUME] Initializing global gain node...");
    // Make sure we have an audio context first
    if (!window.audioContext) {
        console.warn("[VOLUME] Cannot initialize gain node: no audio context");
        return;
    }
    
    // Create gain node if it doesn't exist
    if (!window.globalGainNode) { 
        try {
            window.globalGainNode = window.audioContext.createGain(); 
            window.globalGainNode.gain.value = globalVolumeLevel; 
            window.globalGainNode.connect(window.audioContext.destination);
            console.log(`[VOLUME] Global gain node created with value ${globalVolumeLevel}`);
        } catch (e) {
            console.error('[VOLUME] Failed to create global gain node:', e);
            window.globalGainNode = null;
        }
    } else {
        console.log("[VOLUME] Global gain node already exists");
        // Ensure gain value matches global setting
        try {
            window.globalGainNode.gain.value = globalVolumeLevel;
            console.log(`[VOLUME] Updated existing gain node to ${globalVolumeLevel}`);
        } catch (e) {
            console.error('[VOLUME] Error updating existing gain node:', e);
        }
    }
}

// --- ALL OTHER FUNCTION DEFINITIONS FOLLOW --- 

// Helper function to update slider background fill - improved version
function updateSliderFill(slider) {
    if (!slider) {
        console.warn("[VOLUME] updateSliderFill called with null slider");
        return;
    }
    
    try {
        const min = parseFloat(slider.min || 0);
        const max = parseFloat(slider.max || 1);
        const value = parseFloat(slider.value || 0);
        
        // Calculate percentage (clamped to 0-100 range)
        const percentage = ((value - min) / (max - min)) * 100;
        const clampedPercentage = Math.max(0, Math.min(100, percentage));
        
        // Apply gradient style
        slider.style.background = `linear-gradient(to right, var(--primary-color) ${clampedPercentage}%, rgba(0, 255, 0, 0.1) ${clampedPercentage}%)`;
        
        // console.log(`[VOLUME] Updated slider fill to ${clampedPercentage}%`); // REMOVED THIS LINE
    } catch (error) {
        console.error("[VOLUME] Error updating slider fill:", error);
    }
}

// Uses uppercase keys consistent with how they're stored in the DB via webserver.js
let categoryCounts = {
  'MEDICAL EMERGENCY': 0,
  'INJURED PERSON': 0,
  'DISTURBANCE': 0,
  'VEHICLE COLLISION': 0,
  'BURGLARY': 0,
  'ASSAULT': 0,
  'STRUCTURE FIRE': 0,
  'MISSING PERSON': 0,
  'MEDICAL CALL': 0,
  'BUILDING FIRE': 0,
  'STOLEN VEHICLE': 0,
  'SERVICE CALL': 0,
  'VEHICLE STOP': 0,
  'UNCONSCIOUS PERSON': 0,
  'RECKLESS DRIVER': 0,
  'PERSON WITH A GUN': 0,
  'ALTERED LEVEL OF CONSCIOUSNESS': 0,
  'BREATHING PROBLEMS': 0,
  'FIGHT': 0,
  'CARBON MONOXIDE': 0,
  'ABDUCTION': 0,
  'PASSED OUT PERSON': 0,
  'HAZMAT': 0,
  'FIRE ALARM': 0,
  'TRAFFIC HAZARD': 0,
  'INTOXICATED PERSON': 0,
  'MVC': 0,
  'ANIMAL BITE': 0, // Added
  'ASSIST': 0,      // Added
  'OTHER': 0
};

let newestCallIds = []; // Store IDs of newest calls
const MAX_PULSING_MARKERS = 3; // Maximum number of pulsing markers

// Assigning colors based on incident type similarity. Using uppercase keys.
const CATEGORY_COLORS = {
    // Medical Related (Reds/Pinks - adjusted for better contrast)
    'MEDICAL EMERGENCY':                 '#E53935', // Medium Red
    'INJURED PERSON':                    '#F06292', // Medium Pink
    'MEDICAL CALL':                      '#E53935', // Medium Red
    'UNCONSCIOUS PERSON':                '#F06292', // Medium Pink
    'ALTERED LEVEL OF CONSCIOUSNESS':    '#E53935', // Medium Red
    'BREATHING PROBLEMS':                '#F06292', // Medium Pink
    'PASSED OUT PERSON':                 '#F06292', // Medium Pink
    'ANIMAL BITE':                       '#EF5350', // Slightly Lighter Red

    // Fire Related (Oranges - avoiding pure yellow)
    'STRUCTURE FIRE':                    '#F57C00', // Strong Orange
    'BUILDING FIRE':                     '#F57C00', // Strong Orange
    'FIRE ALARM':                        '#FFA726', // Lighter Orange (Amber)
    'CARBON MONOXIDE':                   '#FFA726', // Lighter Orange (Amber)
    'HAZMAT':                            '#E65100', // Darker Orange/Brownish

    // Police/Crime Related (Blues/Teals - adjusted brightness)
    'DISTURBANCE':                       '#039BE5', // Medium Blue
    'BURGLARY':                          '#26C6DA', // Medium Cyan/Teal
    'ASSAULT':                           '#1E88E5', // Strong Blue
    'STOLEN VEHICLE':                    '#26C6DA', // Medium Cyan/Teal
    'VEHICLE STOP':                      '#4FC3F7', // Lighter, distinct Blue
    'PERSON WITH A GUN':                 '#1E88E5', // Strong Blue
    'FIGHT':                             '#039BE5', // Medium Blue
    'ABDUCTION':                         '#1E88E5', // Strong Blue
    'INTOXICATED PERSON':                '#4FC3F7', // Lighter, distinct Blue

    // Traffic Related (Ambers/Oranges - replaced pure yellow)
    'VEHICLE COLLISION':                 '#FFB300', // Amber/Gold
    'RECKLESS DRIVER':                   '#FFCA28', // Lighter Amber
    'TRAFFIC HAZARD':                    '#FFB300', // Amber/Gold
    'MVC':                               '#FFCA28', // Lighter Amber (Motor Vehicle Collision)

    // Other/Service (Greens/Purples/Greys - ensuring visibility)
    'MISSING PERSON':                    '#66BB6A', // Medium Green
    'SERVICE CALL':                      '#78909C', // Blue Grey (more distinct than plain grey)
    'ASSIST':                            '#78909C', // Blue Grey
    'OTHER':                             '#90A4AE', // Lighter Blue Grey
};

// Pulsing Icon Implementation (Original - for existing markers)
L.Icon.Pulse = L.DivIcon.extend({
    options: {
        className: '',
        iconSize: [12, 12],
        color: 'red', // Default for existing alerts
        heartbeat: 1 // Default pulse speed (lower is faster) for existing alerts
    },
    initialize: function(options) {
        L.setOptions(this, options);
        var uniqueClassName = 'lpi-' + (new Date()).getTime() + '-' + Math.round(Math.random() * 100000);
        this.options.className = this.options.className + ' leaflet-pulsing-icon ' + uniqueClassName;
        var style = document.createElement('style');
        var css = '.' + uniqueClassName + ':after{box-shadow: 0 0 6px 2px ' + this.options.color + '; animation: pulsate ' + this.options.heartbeat + 's ease-out infinite;}';
        if (style.styleSheet) {
            style.styleSheet.cssText = css;
        } else {
            style.appendChild(document.createTextNode(css));
        }
        document.getElementsByTagName('head')[0].appendChild(style);
        L.DivIcon.prototype.initialize.call(this, options);
    }
});

// Helper function to create a new original pulsing icon
L.icon.pulse = function(options) {
    return new L.Icon.Pulse(options);
};

// NEW: User Location Pulsing Icon (Solid dot with pulse)
L.Icon.UserLocationPulse = L.DivIcon.extend({
    options: {
        className: '', // Base class for styling if needed
        iconSize: [16, 16], // Slightly larger for user location dot
        color: '#007bff', // Blue for user location
        heartbeat: 1.2 // Pulse speed for user location
    },
    initialize: function(options) {
        L.setOptions(this, options);

        const uniqueDotClass = 'user-location-dot-' + Date.now();
        const uniquePulseClass = 'user-location-pulse-effect-' + Date.now();

        // Apply the dot class to the main element via options.className
        this.options.className = (this.options.className || '') + ' ' + uniqueDotClass;

        const style = document.createElement('style');
        const css = `
            .${uniqueDotClass} {
                background-color: ${this.options.color};
                width: ${this.options.iconSize[0]}px;
                height: ${this.options.iconSize[1]}px;
                border-radius: 50%;
                box-shadow: 0 0 2px rgba(0,0,0,0.7); /* Sharper shadow for the dot */
                position: relative; /* Needed for :after positioning */
                display: flex; /* For centering if iconSize was just for container */
                align-items: center; /* For centering */
                justify-content: center; /* For centering */
            }
            .${uniqueDotClass}:after {
                content: '';
                position: absolute;
                /* Centering the pulse relative to the dot */
                left: 50%; 
                top: 50%;
                transform: translate(-50%, -50%);
                width: ${this.options.iconSize[0] * 2.5}px; 
                height: ${this.options.iconSize[1] * 2.5}px; 
                border-radius: 50%;
                /* Using a direct animation definition here to avoid conflicts */
                animation-name: userLocationPulsate;
                animation-duration: ${this.options.heartbeat}s;
                animation-timing-function: ease-out;
                animation-iteration-count: infinite;
                box-shadow: 0 0 8px 2px ${this.options.color}; /* Ensure pulse shadow is visible */
                opacity: 0.8; /* Make pulse slightly more opaque */
                z-index: -1; /* Ensure pulse is behind the main dot if dot has content */
            }
            /* Define the keyframes for this specific pulse to avoid global conflicts */
            @keyframes userLocationPulsate {
                0% {
                    transform: translate(-50%, -50%) scale(0.5);
                    opacity: 0.8;
                }
                70% {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 0;
                }
                100% {
                    transform: translate(-50%, -50%) scale(0.5);
                    opacity: 0;
                }
            }
        `;

        if (style.styleSheet) {
            style.styleSheet.cssText = css;
        } else {
            style.appendChild(document.createTextNode(css));
        }
        document.getElementsByTagName('head')[0].appendChild(style);
        L.DivIcon.prototype.initialize.call(this, options);
    }
});

// Helper function for the new user location pulsing icon
L.icon.userLocationPulse = function(options) {
    return new L.Icon.UserLocationPulse(options);
};

// Animation Queue Variables
const animationQueue = [];
let isAnimating = false;

// Create icon objects from config
function createIconsFromConfig() {
    const icons = {};
    
    // Create L.icon objects for each icon in config
    Object.keys(appConfig.icons).forEach(iconKey => {
        icons[iconKey] = L.icon(appConfig.icons[iconKey]);
    });
    
    return icons;
}

// Store icons globally
const customIcons = {};

// Function to add pulsing effect to an existing marker
function addPulsingEffectToMarker(callId) {
    // Skip if marker doesn't exist or already has a pulse effect
    if (!markers[callId] || !allMarkers[callId] || markers[callId].pulseMarker) {
        return;
    }
    
    try {
        // Get the marker's category and determine color
        const category = allMarkers[callId].category || 'OTHER';
        const color = CATEGORY_COLORS[category] || CATEGORY_COLORS['OTHER'];
        
        // Get marker position
        const latlng = markers[callId].getLatLng();
        
        // Create pulsing icon with the category color
        const pulsingIcon = L.icon.pulse({
            iconSize: [15, 15],
            color: color
        });
        
        // Create a pulsing marker at the same position
        const pulseMarker = L.marker(latlng, {
            icon: pulsingIcon,
            zIndexOffset: -100, // Position behind the original marker
            interactive: false  // Prevent interaction with the pulsing marker
        });
        
        // Add to map
        pulseMarker.addTo(map);
        
        // Store reference to pulse marker in original marker
        markers[callId].pulseMarker = pulseMarker;
        
        // console.log(`Added pulsing effect to marker ${callId} with color ${color}`); // REMOVED THIS LINE
    } catch(e) {
        console.error("Error creating pulse marker:", e, e.stack);
    }
}

// Function to remove pulsing effect from a marker
function removePulsingEffect(callId) {
    if (markers[callId] && markers[callId].pulseMarker) {
        map.removeLayer(markers[callId].pulseMarker);
        delete markers[callId].pulseMarker;
        // console.log(`Removed pulsing effect from marker ${callId}`); // REMOVED THIS LINE
    }
}

// Function to update which markers should have pulsing effects
function updatePulsingMarkers() {
    console.log("Updating pulsing markers, newest call IDs:", newestCallIds);
    
    // Remove pulsing effect from all markers that are no longer in the newest list
    Object.keys(markers).forEach(callId => {
        if (!newestCallIds.includes(callId) && markers[callId] && markers[callId].pulseMarker) {
            removePulsingEffect(callId);
        }
    });
    
    // Add pulsing effect to newest markers if they don't already have it
    newestCallIds.forEach(callId => {
        if (markers[callId] && !markers[callId].pulseMarker && allMarkers[callId].visible) {
            addPulsingEffectToMarker(callId);
        }
    });
}

// Function to update pulsing marker positions when their parent markers move
function updatePulsingMarkerPositions() {
    Object.keys(markers).forEach(callId => {
        if (markers[callId] && markers[callId].pulseMarker) {
            markers[callId].pulseMarker.setLatLng(markers[callId].getLatLng());
        }
    });
}

function addPermanentHouseMarkers() {
    // Create a separate layer group for permanent markers
    const houseMarkersGroup = L.layerGroup();

    // Add each house to the map
    appConfig.permanentLocations.houses.forEach(location => {
        // Create marker
        const marker = L.marker([location.lat, location.lng], { 
            icon: customIcons.house,
            zIndexOffset: 1000,  // Ensure houses appear above other markers
            interactive: false   // This makes the marker non-interactive (no click events)
        });
        
        // Add the marker to the permanent layer group
        houseMarkersGroup.addLayer(marker);
    });

    // Add the permanent markers layer to the map
    map.addLayer(houseMarkersGroup);
    
    // Store the layer group in a global variable to avoid it being garbage collected
    window.houseMarkersGroup = houseMarkersGroup;
}

function setupTimeFilter() {
    const timeFilterSelect = document.getElementById('time-filter');
    timeFilterSelect.addEventListener('change', handleTimeFilterChange);
}

function handleTimeFilterChange(event) {
    const selectedValue = event.target.value;
    if (selectedValue === 'custom') {
        showCustomTimeModal();
    } else {
        timeRangeHours = parseInt(selectedValue, 10);
        console.log(`Time range changed to ${timeRangeHours} hours`);
        loadCalls(timeRangeHours);
    }
}

function showCustomTimeModal() {
    const modal = document.getElementById('custom-time-modal');
    modal.style.display = 'block';
}

function setupLiveStreamButton() {
    const liveStreamButton = document.createElement('button');
    liveStreamButton.id = 'live-stream-button';
    liveStreamButton.textContent = appConfig.ui.liveStreamButtonText;
    liveStreamButton.className = 'cyberpunk-button';
    
    // Insert the button after the toggle mode button
    const toggleModeButton = document.getElementById('toggle-mode');
    if (toggleModeButton && toggleModeButton.parentNode) {
        toggleModeButton.parentNode.insertBefore(liveStreamButton, toggleModeButton.nextSibling);
    }
    
    // We don't need the audio container anymore, but keeping it for compatibility
    audioContainer = document.createElement('div');
    audioContainer.id = 'audio-container';
    audioContainer.style.display = 'none';
    document.body.appendChild(audioContainer);
    
    liveStreamButton.addEventListener('click', toggleLiveStream);
}

// Initialize the category sidebar
/* // REMOVE THIS FUNCTION ENTIRELY
function initCategorySidebar() {
  const categoryList = document.getElementById('category-list');
  categoryList.innerHTML = '';

  // Check if we're on mobile and adjust styling accordingly
  if (isMobile()) {
    document.getElementById('category-sidebar').style.maxHeight =
      `${window.innerHeight - 350}px`;
  }

  Object.keys(categoryCounts).forEach(category => {
    const categoryItem = document.createElement('div');
    categoryItem.className = 'category-item';
    categoryItem.dataset.category = category;
    categoryItem.innerHTML = `
      <div class="category-name">${category}</div>
      <div class="category-count">${categoryCounts[category]}</div>
    `;

    categoryItem.addEventListener('click', () => {
      toggleCategoryFilter(category);
    });

    categoryList.appendChild(categoryItem);
  });

  // Add "All" category
  const allCategory = document.createElement('div');
  allCategory.className = 'category-item active';
  allCategory.dataset.category = 'ALL';
  allCategory.innerHTML = `
    <div class="category-name">ALL</div>
    <div class="category-count">${Object.values(categoryCounts).reduce((a, b) => a + b, 0)}</div>
  `;

  allCategory.addEventListener('click', () => {
    toggleCategoryFilter('ALL');
  });

  categoryList.prepend(allCategory);

  // Add resize handler for mobile
  window.addEventListener('resize', () => {
    if (isMobile()) {
      document.getElementById('category-sidebar').style.maxHeight =
        `${window.innerHeight - 350}px`;
    }
  });
}
*/

// Toggle category filter
function toggleCategoryFilter(category) {
  // Reset active state for all categories
  /* // Logic moved to updateCategoryCounts / handled by re-rendering
  document.querySelectorAll('.category-item').forEach(item => {
    item.classList.remove('active');
  });

  // Set active state for selected category
  const categoryElement = document.querySelector(`.category-item[data-category="${category}"]`);
  if (categoryElement) {
    categoryElement.classList.add('active');
  }
  */

  selectedCategory = category === 'ALL' ? null : category;

  // Apply filters (this will trigger updateCategoryCounts which handles active state)
  applyFilters();

  // If switching to ALL category, ensure pulsing markers are updated
  // This might not be necessary if applyFilters correctly handles visibility
  // if (category === 'ALL') {
  //   updatePulsingMarkers();
  // }
}


// Update category counts and dynamically update sidebar
function updateCategoryCounts() {
    const categoryList = document.getElementById('category-list');
    if (!categoryList) {
        console.error("Category list element not found!");
        return;
    }

    // 1. Calculate counts for visible markers
    const currentCounts = {};
    // Initialize with known categories to ensure they are checked even if count becomes 0
    Object.keys(categoryCounts).forEach(category => {
        currentCounts[category] = 0;
    });
    let totalVisible = 0;

    Object.values(allMarkers).forEach(data => {
        // Count only if the marker is currently visible according to filters
        if (data.visible) {
            totalVisible++;
            const category = data.category || 'OTHER'; // Use 'OTHER' if undefined/null
            // Ensure we only count valid, known categories or 'OTHER'
            if (currentCounts.hasOwnProperty(category)) {
                currentCounts[category]++;
            } else {
                // If the category from the data isn't in our initial list, count it as 'OTHER'
                currentCounts['OTHER']++;
            }
        }
    });

    // 2. Prepare list of categories with counts > 0
    const categoriesToShow = [];
    for (const category in currentCounts) {
        if (currentCounts[category] > 0) {
            categoriesToShow.push({ name: category, count: currentCounts[category] });
        }
    }

    // 3. Sort categories alphabetically
    categoriesToShow.sort((a, b) => a.name.localeCompare(b.name));

    // 4. Rebuild the category list (excluding 'ALL' for now)
    categoryList.innerHTML = ''; // Clear previous category-specific items

    // 5. Add sorted categories with counts > 0
    categoriesToShow.forEach(catInfo => {
        const categoryItem = document.createElement('div');
        categoryItem.className = 'category-item';
        categoryItem.dataset.category = catInfo.name;
        categoryItem.innerHTML = `
            <div class="category-name">${catInfo.name}</div>
            <div class="category-count">${catInfo.count}</div>
        `;

        // Highlight if it's the currently selected category
        if (selectedCategory === catInfo.name) {
            categoryItem.classList.add('active');
        }

        categoryItem.addEventListener('click', () => {
            // Pass the actual category name to the filter function
            toggleCategoryFilter(catInfo.name);
        });

        categoryList.appendChild(categoryItem);
    });

    // 6. Handle the "ALL" category
    const allCategoryItem = document.createElement('div');
    allCategoryItem.className = 'category-item';
    allCategoryItem.dataset.category = 'ALL';
    allCategoryItem.innerHTML = `
        <div class="category-name">ALL</div>
        <div class="category-count">${totalVisible}</div>
    `;
    // Set 'ALL' as active if no specific category is selected
    if (!selectedCategory) {
        allCategoryItem.classList.add('active');
    }
    allCategoryItem.addEventListener('click', () => {
        toggleCategoryFilter('ALL');
    });

    // Add 'ALL' to the top
    categoryList.prepend(allCategoryItem);

    // 7. Check if the currently selected category is still visible
    if (selectedCategory && currentCounts[selectedCategory] === 0) {
        console.log(`Selected category "${selectedCategory}" no longer has visible markers. Resetting to ALL.`);
        // Update state and visually reset in the next filter application
        selectedCategory = null; // Reset internal state
        // Re-apply filters which will call updateCategoryCounts again and highlight ALL
        applyFilters();
    }

    // 8. Adjust sidebar height for mobile
    // Consider moving resize logic to a dedicated function if it becomes complex
    if (isMobile()) {
        const sidebar = document.getElementById('category-sidebar');
        if (sidebar) {
           // Adjusted height: Viewport - control panel (180) - summary bar (50) - buffer (20)
           sidebar.style.maxHeight = `${window.innerHeight - 180 - 50 - 20}px`;
        }
    }
}

// Start timestamp update interval
function startTimestampUpdates() {
  // Clear any existing interval
  if (timestampUpdateInterval) {
    clearInterval(timestampUpdateInterval);
  }
  
  // Update timestamps every minute
  timestampUpdateInterval = setInterval(() => {
    updatePopupTimestamps();
    removeExpiredMarkers();
  }, 60000); // every minute
}

// Update timestamps in open popups
function updatePopupTimestamps() {
  Object.keys(markers).forEach(callId => {
    const marker = markers[callId];
    if (marker && marker.isPopupOpen()) {
      const timestampContainer = marker.getPopup().getContent().querySelector('.popup-timestamp');
      if (timestampContainer) {
        const callTimestamp = allMarkers[callId].timestamp;
        timestampContainer.innerHTML = `<small>${formatTimestamp(callTimestamp)}</small>`;
      }
    }
  });
}

// Remove markers that no longer match the time filter
function removeExpiredMarkers() {
  const now = new Date();
  const filterTime = new Date(now.getTime() - timeRangeHours * 60 * 60 * 1000);

  Object.keys(allMarkers).forEach(callId => {
    // Multiply Unix timestamp by 1000 for correct comparison
    const callTime = new Date(allMarkers[callId].timestamp * 1000);
    // Only act on markers that are currently visible
    if (allMarkers[callId].visible && callTime < filterTime) {
        // Remove from map
        markerGroups.removeLayer(markers[callId]);
        allMarkers[callId].visible = false;
        // Remove pulsing if present
        if (markers[callId].pulseMarker) {
            map.removeLayer(markers[callId].pulseMarker);
        }
    }
  });

  // Update category counts after potentially removing markers
  updateCategoryCounts();
}


function toggleLiveStream() {
    // Open the rdio website in a new tab
    window.open(appConfig.audio.liveStreamUrl, '_blank');
}

// These functions are no longer used, but keeping empty stubs for compatibility
// in case they're called from elsewhere in the code
function createStreamIframe() {
    // Function no longer needed
}

function stopStream() {
    // Function no longer needed
}

function showStreamError() {
    // Function no longer needed
}

function applyCustomTimeFilter() {
    const startDate = document.getElementById('custom-start-date').value;
    const startTime = document.getElementById('custom-start-time').value;
    const endDate = document.getElementById('custom-end-date').value;
    const endTime = document.getElementById('custom-end-time').value;

    const start = new Date(`${startDate}T${startTime}:00Z`); // Ensure UTC
    const end = new Date(`${endDate}T${endTime}:00Z`); // Ensure UTC

    if (start && end && start < end) {
        const diffHours = (end - start) / (1000 * 60 * 60);
        timeRangeHours = diffHours;
        applyFilters();
        document.getElementById('custom-time-modal').style.display = 'none';
    } else {
        alert('Please enter valid start and end times.');
    }
}

// Initialize audio context
function initAudioContext() {
    console.log("[VOLUME] Initializing AudioContext..."); 
    try {
        if (!window.audioContext) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            window.audioContext = new AudioContext();
            console.log(`[VOLUME] New AudioContext created. State: ${window.audioContext.state}`);
            
            // Initialize gain node right after context creation
            initGlobalGainNode(); 

            // If the context starts suspended, try to resume it immediately
            if (window.audioContext.state === 'suspended') {
                window.audioContext.resume()
                    .then(() => console.log('[VOLUME] AudioContext resumed'))
                    .catch(e => console.warn('[VOLUME] Resume failed:', e));
            }
        } else {
            console.log(`[VOLUME] AudioContext already exists. State: ${window.audioContext.state}`);
            // Ensure gain node exists
            if (!window.globalGainNode) {
                initGlobalGainNode();
            }
            // Resume if suspended
            if (window.audioContext.state === 'suspended') {
                window.audioContext.resume()
                    .then(() => console.log('[VOLUME] Existing AudioContext resumed'))
                    .catch(e => console.warn('[VOLUME] Resume failed:', e));
            }
        }
    } catch (e) {
        console.error('[VOLUME] Error initializing AudioContext:', e);
    }
}

// Attempt to play a silent buffer to unlock/resume the AudioContext
function attemptAutoplay() {
    // Create a silent audio context instead of using an Audio element
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        
        // Set gain to 0 to make it silent
        gain.gain.value = 0;
        
        // Connect nodes
        oscillator.connect(gain);
        gain.connect(context.destination);
        
        // Start and stop quickly
        oscillator.start(0);
        oscillator.stop(0.001);
        
        console.log("Autoplay enabled via AudioContext");
    } catch (error) {
        console.warn("Autoplay setup failed:", error);
    }
}

// Initialize map
function initMap() {
    // Initialize the map with the configuration center and zoom level
    map = L.map('map', {
        center: appConfig.map.defaultCenter,
        zoom: appConfig.map.defaultZoom,
        maxZoom: appConfig.map.maxZoom,
        minZoom: appConfig.map.minZoom,
        zoomControl: !isMobile(),
        tap: true
    });

    // Day layer using OpenStreetMap
    dayLayer = L.tileLayer(appConfig.mapStyles.dayLayer, {
        attribution: appConfig.map.attribution,
        maxZoom: appConfig.map.maxZoom,
        crossOrigin: true
    });

    // Add CSS for dark mode tiles
    const style = document.createElement('style');
    style.textContent = `
        .dark-mode-tiles {
            filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%);
        }
        .dark-mode-tiles img {
            background: #0e1216;
        }
        
        /* Preserve marker colors */
        .leaflet-marker-icon,
        .leaflet-marker-shadow,
        .marker-cluster-small,
        .marker-cluster-medium,
        .marker-cluster-large {
            filter: none !important;
        }
    `;
    document.head.appendChild(style);

    // Night layer using filtered OpenStreetMap
    nightLayer = L.tileLayer(appConfig.mapStyles.dayLayer, {
        attribution: appConfig.map.attribution,
        maxZoom: appConfig.map.maxZoom,
        crossOrigin: true,
        className: 'dark-mode-tiles'
    });

    // Satellite view using two layers combined
    const satelliteBase = L.tileLayer(appConfig.mapStyles.satelliteBaseLayer, {
        attribution: appConfig.map.attribution,
        maxZoom: appConfig.map.maxZoom,
        crossOrigin: true
    });

    const satelliteLabels = L.tileLayer(appConfig.mapStyles.satelliteLabelsLayer, {
        attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        maxZoom: appConfig.map.maxZoom,
        crossOrigin: true
    });

    satelliteLayer = L.layerGroup([satelliteBase, satelliteLabels]);

    dayLayer.addTo(map);

    markerGroups = L.markerClusterGroup({
        iconCreateFunction: function(cluster) {
            const childCount = cluster.getChildCount();
            let c = ' marker-cluster-';
            if (childCount < 10) {
                c += 'small';
            } else if (childCount < 100) {
                c += 'medium';
            } else {
                c += 'large';
            }

            return L.divIcon({
                html: '<div><span>' + childCount + '</span></div>',
                className: 'marker-cluster' + c,
                iconSize: L.point(40, 40)
            });
        },
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: true,
        zoomToBoundsOnClick: true,
        maxClusterRadius: 55,
        spiderfyDistanceMultiplier: 2
    });

    map.addLayer(markerGroups);

    if (isMobile()) {
    L.control.zoom({ position: 'bottomright' }).addTo(map);
} else {
    L.control.zoom({ position: 'topright' }).addTo(map);
}

    setupEventListeners();
    L.control.scale().addTo(map);
    loadCalls(timeRangeHours);

    map.on('zoomend', function() {
        console.log('Current zoom level:', map.getZoom());
        addPermanentHouseMarkers();
    });
}

// Event Listeners Setup
function setupEventListeners() {
    toggleModeButton = document.getElementById('toggle-mode');
    if (toggleModeButton) {
        toggleModeButton.addEventListener('click', toggleMapMode);
        // Set the initial text directly to "Day":
        toggleModeButton.textContent = 'Day'; // Assuming starting in day mode
    } else {
        console.error('Toggle mode button not found');
    }

    window.addEventListener('resize', handleWindowResize);

    // Add event listener for "Get More Info" buttons using event delegation
    document.addEventListener('click', function(event) {
        if (event.target.classList.contains('get-more-info')) {
            handleGetMoreInfo(event);
        }
    });
}

// Toggle Map Mode (Day, Night, Satellite)
function toggleMapMode() {
    if (currentMapMode === 'day') {
        map.removeLayer(dayLayer);
        nightLayer.addTo(map);
        currentMapMode = 'night';
        // Use direct text assignment
        toggleModeButton.textContent = 'Night';
    } else if (currentMapMode === 'night') {
        map.removeLayer(nightLayer);
        satelliteLayer.addTo(map);
        currentMapMode = 'satellite';
        // Use direct text assignment
        toggleModeButton.textContent = 'Satellite';
    } else if (currentMapMode === 'satellite') {
        map.removeLayer(satelliteLayer);
        dayLayer.addTo(map);
        currentMapMode = 'day';
        // Use direct text assignment
        toggleModeButton.textContent = 'Day';
    }
}

// Setup Calls and Socket.IO Updates
function setupCallsAndUpdates() {
    loadCalls(timeRangeHours);
    initializeSocketIO();
}

// Initialize Socket.IO
function initializeSocketIO() {
    socket = io();

    socket.on('connect', () => console.log('Connected to Socket.IO server.'));
    socket.on('disconnect', () => console.log('Disconnected from Socket.IO server.'));

    /* // RE-ENABLED DEBUG LISTENER -> COMMENTING OUT AGAIN
    socket.onAny((eventName, ...args) => {
        console.log(`Received event \"${eventName}\":`, args);
    });
    */

    // Listener for map updates (Keep as is)
    socket.on('newCall', handleNewCall);
    
    // Restore direct Listener for live feed updates
    socket.on('liveFeedUpdate', handleLiveFeedUpdate); 
    
    socket.on('error', (error) => console.error('Socket.IO Error:', error));
    socket.on('serverMessage', (message) => console.log('Server message:', message));
    socket.on('pong', () => console.log('Received pong from server'));

    socket.io.on('reconnect_attempt', () => console.log('Attempting to reconnect to Socket.IO server...'));
    socket.io.on('reconnect', handleReconnect);
    socket.io.on('reconnect_error', (error) => console.error('Failed to reconnect to Socket.IO server:', error));

    setInterval(() => {
        if (socket.connected) socket.emit('ping');
    }, 30000);
}

// Handle Reconnect Event
function handleReconnect() {
    console.log('Reconnected to Socket.IO server.');
    // If there were any actions to re-establish after reconnect, handle them here
}

// Handle New Call Event
function handleNewCall(call) {
    console.log('Received newCall event:', call);

    if (markers[call.id]) {
        console.log(`Call ID ${call.id} already exists. Skipping.`);
        return;
    }

    if (isValidCall(call)) {
        // Multiply Unix timestamp by 1000 for correct date comparison
        const callTimestamp = new Date(call.timestamp * 1000);
        const sinceTimestamp = new Date(Date.now() - timeRangeHours * 60 * 60 * 1000);

        if (callTimestamp >= sinceTimestamp) {
            const added = addMarker(call, true);
            if (added) {
                console.log('New marker added for call:', call.id);
                const marker = markers[call.id];
                if (marker) {
                    // Show new call banner with talk group name and category
                    showNewCallBanner(call.talk_group_name || 'Unknown Talk Group', call.category || 'OTHER');
                    
                    // Add new call ID to the beginning of newestCallIds array
                    newestCallIds.unshift(call.id);
                    
                    // Limit to MAX_PULSING_MARKERS
                    if (newestCallIds.length > MAX_PULSING_MARKERS) {
                        // Remove pulsing from the oldest call that's no longer in top 3
                        const oldestId = newestCallIds.pop();
                        removePulsingEffect(oldestId);
                    }
                    
                    // Add pulsing to the new call
                    addPulsingEffectToMarker(call.id);
                    
                    // Only animate to the new marker if tracking is enabled
                    if (isTrackingNewCalls) {
                        console.log(`[Track New Call] Tracking enabled. Enqueuing animation for call ID ${call.id}.`);
                        enqueueAnimation(marker, () => {
                            console.log(`[Track New Call] Animation completed. Calling handleMarkerVisibility for call ID ${call.id}.`);
                            handleMarkerVisibility(marker);
                        });
                    }
                    
                    // Play new call sound if not muted
                    if (!isNewCallAudioMuted) {
                        playNewCallSound();
                    }
                    
                    // Update category counts
                    updateCategoryCounts();
                }
            }
        }
    } else {
        console.warn('Invalid call data received:', call);
    }
}


// Function to show the new call banner
function showNewCallBanner(talkGroup, category) {
  const banner = document.getElementById('new-call-banner');
  const talkGroupSpan = document.getElementById('talkgroup-name');
  
  talkGroupSpan.textContent = `${talkGroup} `;
  
  // Add category badge if available
  if (category) {
    const categoryBadge = document.createElement('span');
    categoryBadge.className = 'category-badge';
    categoryBadge.textContent = category;
    categoryBadge.style.cssText = `
      background-color: var(--hover-color);
      color: #00ccff;
      padding: 2px 6px;
      border-radius: 10px;
      font-size: 12px;
      margin-left: 5px;
    `;
    talkGroupSpan.appendChild(categoryBadge);
  }
  
  banner.classList.remove('hidden');
  
  setTimeout(() => {
    banner.classList.add('hidden');
  }, 4000);
}

// Add Marker to Map
function addMarker(call, isNew = false) {
    console.log('Adding marker for call:', call);
    if (isValidCall(call)) {
        const icon = getMarkerIcon(call.talk_group_name, call.talk_group_id, call.audio_file_path);
        console.log('Icon assigned:', icon);
        const marker = L.marker([call.lat, call.lon], { icon: icon });
        
        // Create popup content container
        const popupContent = document.createElement('div');
        popupContent.className = 'custom-popup';
        
        // Create top container that holds links and timestamp
        const topContainer = document.createElement('div');
        topContainer.className = 'popup-top-container'; // Use class for styling
        
        // Create links container (left side)
        const topLinksContainer = document.createElement('div');
        topLinksContainer.className = 'popup-top-links'; // Use class for styling
        
        // Create street view link
        const streetViewLink = document.createElement('a');
        streetViewLink.href = `https://www.google.com/maps?layer=c&cbll=${call.lat},${call.lon}`;
        streetViewLink.target = '_blank';
        streetViewLink.className = 'street-view-link';
        streetViewLink.innerHTML = 'Street View';
        // style.cssText is no longer needed here if using class
        
        // Create correction link (admin only when auth enabled, always when auth disabled)
        let correctionLink = null;
        if (isAdminUser || !authEnabled) { // Show button for admin users OR when auth is disabled
            correctionLink = document.createElement('a');
            correctionLink.href = '#';
            correctionLink.className = authEnabled ? 'correction-link admin-only' : 'correction-link'; // Only add admin-only class when auth is enabled
            correctionLink.textContent = 'Edit Marker';
            correctionLink.title = authEnabled ? 'Admin Only - Edit Marker Location' : 'Edit Marker Location'; // Adjust title based on auth status
            // style.cssText is no longer needed here if using class
            correctionLink.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showCorrectionModal(call.id, marker);
            });
        }

        // Create timestamp container (right side)
        const timestampContainer = document.createElement('div');
        timestampContainer.className = 'popup-timestamp'; // Use class for styling
        timestampContainer.innerHTML = `<small>${formatTimestamp(call.timestamp)}</small>`;

        // Add links to the left container
        topLinksContainer.appendChild(streetViewLink);
        if (correctionLink) {
            topLinksContainer.appendChild(correctionLink);
        } else if (authEnabled) {
            // Show admin-only message for non-admin users when auth is enabled
            const adminOnlyMsg = document.createElement('span');
            adminOnlyMsg.className = 'admin-only-message';
            adminOnlyMsg.textContent = 'Admin Only';
            adminOnlyMsg.title = 'Edit Marker requires admin privileges';
            topLinksContainer.appendChild(adminOnlyMsg);
        }

        // Add both containers to the top container
        topContainer.appendChild(topLinksContainer);
        topContainer.appendChild(timestampContainer);

        // Add the top container to the popup content
        popupContent.appendChild(topContainer);

        // Add the main content with talk group name and category on separate lines
        const contentWrapper = document.createElement('div');
        
        // Create talk group and category HTML with enhanced styling
        let mainContentHTML = '';
        
        // Add talk group name
        mainContentHTML += `<b>${call.talk_group_name || 'Unknown Talk Group'}</b>`;
        
        // Add category with blue theme styling if it exists
        if (call.category) {
            mainContentHTML += `<span class="category-badge">${call.category}</span>`; // Use class for styling
        }
        
        // Add transcription and audio controls
        mainContentHTML += `<br>${call.transcription || 'No transcription available.'}<br>
            <div id="waveform-${call.id}" class="waveform"></div>
            <div class="audio-controls">
                <button class="play-pause" data-call-id="${call.id}" aria-label="Play audio for call ${call.id}">Play</button>
                <!-- NEW: Live Feed Toggle Checkbox -->
                <div class="popup-live-feed-control">
                    <input type="checkbox" id="popup-live-feed-toggle-${call.id}" class="popup-live-feed-toggle" data-tg-id="${call.talk_group_id}">
                    <label for="popup-live-feed-toggle-${call.id}">Add to Live Feed</label> <!-- Changed Label Text -->
                </div>
                <button class="talkgroup-history-btn" data-talkgroup-id="${call.talk_group_id}" data-call-id="${call.id}" data-talkgroup-name="${call.talk_group_name || 'Unknown Talk Group'}">More Info</button>
                <!-- REMOVED: <input type="range" class="volume" min="0" max="1" step="0.1" value="1" data-call-id="${call.id}" aria-label="Volume control for call ${call.id}"> -->
            </div>
            <!-- REMOVED: <div class="additional-info"></div> -->
        `;
        
        contentWrapper.innerHTML = mainContentHTML;
        popupContent.appendChild(contentWrapper);

        // Bind popup with content
        marker.bindPopup(popupContent);
        
        // Rest of your function remains unchanged
        if (isNew) {
            marker.shouldPlayAudio = true;
            console.log(`Marker for callId ${call.id} flagged to play audio on popup open.`);
        }
        
        // Handle popup open event
        marker.on('popupopen', function() {
            // console.log(`Popup opened for callId: ${call.id}`); // REMOVED THIS LOG
            // --- MODIFIED: Use call.id for audio URL ---
            initWaveSurfer(call.id, `/audio/${call.id}`, wavesurfers, () => { // Pass main wavesurfers object
                if (!isNewCallAudioMuted && this.shouldPlayAudio) {
                    playWaveSurferAudio(call.id, wavesurfers, this);
                }
            });

            const popupElement = this.getPopup().getElement();

            // Add listener for the history button *inside* popupopen
            const historyButton = popupElement.querySelector('.talkgroup-history-btn');
            if (historyButton) {
                 // Remove previous listener if any to prevent duplicates
                 historyButton.removeEventListener('click', handleShowTalkgroupHistory);
                 historyButton.addEventListener('click', handleShowTalkgroupHistory);
            }

            // ---- NEW: Setup Popup Live Feed Toggle ----
            const liveFeedToggle = popupElement.querySelector(`.popup-live-feed-toggle[data-tg-id="${call.talk_group_id}"]`);
            if (liveFeedToggle) {
                const talkgroupId = parseInt(call.talk_group_id, 10);
                // Set initial state
                liveFeedToggle.checked = liveFeedSelectedTalkgroups.has(talkgroupId);

                // Add change listener
                liveFeedToggle.addEventListener('change', function() {
                    if (this.checked) {
                        liveFeedSelectedTalkgroups.add(talkgroupId);
                        console.log(`[LiveFeed Popup] Added TG ID ${talkgroupId}. Current set:`, liveFeedSelectedTalkgroups);
                    } else {
                        liveFeedSelectedTalkgroups.delete(talkgroupId);
                        console.log(`[LiveFeed Popup] Removed TG ID ${talkgroupId}. Current set:`, liveFeedSelectedTalkgroups);
                    }
                    // Update main display visibility
                    updateLiveFeedDisplayVisibility();
                    // Update checkbox in modal if open
                    updateLiveFeedModalCheckbox(talkgroupId, this.checked);
                    // NEW: Update audio state based on selection
                    isLiveFeedAudioEnabled = liveFeedSelectedTalkgroups.size > 0;
                    console.log(`[LiveFeed] Audio state updated to: ${isLiveFeedAudioEnabled}`);
                });
            }
            // ---- END NEW ----
        });
        
        // Handle popup close event
        marker.on('popupclose', function() {
            if (wavesurfers[call.id]) {
                wavesurfers[call.id].pause();
                const playPauseButton = document.querySelector(`.play-pause[data-call-id="${call.id}"]`);
                if (playPauseButton) {
                    playPauseButton.textContent = 'Play';
                }
            }
             // Optional: Remove history button listener on close?
             // const historyButton = this.getPopup()?.getElement()?.querySelector('.talkgroup-history-btn');
             // if (historyButton) historyButton.removeEventListener('click', handleShowTalkgroupHistory);
        });
        
        markerGroups.addLayer(marker);
        markers[call.id] = marker; // Corrected: use call.id
        allMarkers[call.id] = { 
            marker: marker, 
            transcription: call.transcription.toLowerCase(), 
			category: call.category ? call.category.toUpperCase() : 'OTHER', // Ensure uppercase for category matching
            timestamp: call.timestamp,
            visible: true
        };

        // Update heatmap if active
        if (document.getElementById('enable-heatmap').checked) {
            updateHeatmap();
        }

        return true;
    } else {
        console.warn('Invalid call data:', call);
        return false;
    }
}

function showCorrectionModal(callId, marker) {
  const modal = document.createElement('div');
  modal.className = 'modal correction-modal';
  modal.innerHTML = `
    <div class="modal-content bg-gray-800 text-white p-4 rounded-lg shadow-lg">
      <h2 class="text-xl mb-4">Marker Correction Options</h2>
      <div class="flex flex-col space-y-4">
        <button id="address-marker" class="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded">
          Enter Address
        </button>
        <button id="relocate-marker" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">
          Manual Correction
        </button>
        <button id="delete-marker" class="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded">
          Delete Marker
        </button>
        <button id="cancel-correction" class="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded">
          Cancel
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Handle address search
  document.getElementById('address-marker').addEventListener('click', () => {
    startAddressSearch(callId, marker, modal);
  });

  // Handle relocate
  document.getElementById('relocate-marker').addEventListener('click', () => {
    startMarkerRelocation(callId, marker, modal);
  });

  // Handle delete
  document.getElementById('delete-marker').addEventListener('click', () => {
    if (confirm('Are you sure you want to delete this marker? This action cannot be undone.')) {
      deleteMarker(callId, marker, modal);
    }
  });

  // Handle cancel
  document.getElementById('cancel-correction').addEventListener('click', () => {
    modal.remove();
  });
}

// LocationIQ Autocomplete Dropdown Function
function createLocationIQDropdown(inputElement, scope) {
  const dropdown = document.createElement('div');
  dropdown.className = 'locationiq-dropdown';
  dropdown.style.cssText = `
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background-color: #000;
    border: 1px solid #00ff00;
    border-top: none;
    border-radius: 0 0 4px 4px;
    max-height: 200px;
    overflow-y: auto;
    z-index: 1000;
    display: none;
  `;
  
  // Insert dropdown after input
  inputElement.parentNode.insertBefore(dropdown, inputElement.nextSibling);
  
  let searchTimeout = null;
  let selectedIndex = -1;
  
  // Add input event listener
  inputElement.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    
    // Clear previous timeout
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }
    
    // Hide dropdown if query is too short
    if (query.length < appConfig.geocoding.minQueryLength) {
      dropdown.style.display = 'none';
      selectedIndex = -1;
      return;
    }
    
    // Debounce search
    searchTimeout = setTimeout(() => {
      searchLocationIQ(query, dropdown, inputElement, scope);
    }, 300);
  });
  
  // Handle keyboard navigation
  inputElement.addEventListener('keydown', (e) => {
    const items = dropdown.querySelectorAll('.locationiq-item');
    
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
        updateSelection(items, selectedIndex);
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, -1);
        updateSelection(items, selectedIndex);
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0 && items[selectedIndex]) {
          selectLocationIQItem(items[selectedIndex], inputElement, dropdown, scope);
        }
        break;
      case 'Escape':
        dropdown.style.display = 'none';
        selectedIndex = -1;
        break;
    }
  });
  
  // Handle clicks outside dropdown
  document.addEventListener('click', (e) => {
    if (!inputElement.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = 'none';
      selectedIndex = -1;
    }
  });
  
  return dropdown;
}

// Search LocationIQ API
  async function searchLocationIQ(query, dropdown, inputElement, scope) {
  try {
    // Get current map center for dynamic bias
    const mapCenter = map.getCenter();
    const biasLat = mapCenter.lat;
    const biasLon = mapCenter.lng;
    
    // Calculate viewbox around the bias point (roughly 50km radius)
    const viewboxRadius = 0.5; // degrees (roughly 50km)
    const viewbox = `${biasLon + viewboxRadius},${biasLat + viewboxRadius},${biasLon - viewboxRadius},${biasLat - viewboxRadius}`;
    
    console.log('[LocationIQ] Viewbox created:', viewbox, 'around point:', biasLat, biasLon);
    
    // Use the server-side geocoding proxy so API keys never reach the browser.
    const apiUrl = `/api/geocode/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(apiUrl);

    if (!response.ok) {
      throw new Error(`Geocoding proxy error: ${response.status}`);
    }

    const payload = await response.json();
    const results = (payload.results || []).map(r => ({
      lat: r.lat,
      lon: r.lon,
      display_place: r.label,
      display_address: r.label,
      display_name: r.label,
    }));
    
    console.log('[LocationIQ] Number of results:', results.length);
    
    // Clear dropdown
    dropdown.innerHTML = '';
    
    if (results.length === 0) {
      dropdown.style.display = 'none';
      return;
    }
    
    // Add results to dropdown
    results.forEach((result, index) => {
      const item = document.createElement('div');
      item.className = 'locationiq-item';
      item.style.cssText = `
        padding: 8px 12px;
        cursor: pointer;
        border-bottom: 1px solid #333;
        color: #00ff00;
        font-family: 'Share Tech Mono', monospace;
        font-size: 12px;
      `;
      
      // Store coordinates in dataset
      item.dataset.lat = result.lat;
      item.dataset.lon = result.lon;
      
      item.innerHTML = `
        <div style="font-weight: bold; color: #00ccff;">${result.display_place || result.address?.name || 'Unknown'}</div>
        <div style="color: #888; font-size: 11px;">${result.display_address || result.display_name || ''}</div>
      `;
      
      item.addEventListener('click', () => {
        selectLocationIQItem(item, inputElement, dropdown, scope);
      });
      
      item.addEventListener('mouseenter', () => {
        selectedIndex = index;
        updateSelection(dropdown.querySelectorAll('.locationiq-item'), selectedIndex);
      });
      
      dropdown.appendChild(item);
    });
    
    dropdown.style.display = 'block';
    selectedIndex = -1;
    
  } catch (error) {
    console.error('[LocationIQ] Search error:', error);
    dropdown.style.display = 'none';
  }
}

// Select LocationIQ item
function selectLocationIQItem(item, inputElement, dropdown, scope) {
  const placeName = item.querySelector('div:first-child').textContent;
  const address = item.querySelector('div:last-child').textContent;
  
  // Get coordinates from the item's data
  const lat = parseFloat(item.dataset.lat);
  const lng = parseFloat(item.dataset.lon);
  
  if (isNaN(lat) || isNaN(lng)) {
    console.error('[LocationIQ] Invalid coordinates:', item.dataset);
    showNotification('Invalid location data received.', 'error');
    return;
  }
  
  // Update input value
  inputElement.value = `${placeName}, ${address}`;
  
  // Update variables in the startAddressSearch scope
  if (scope) {
    scope.newAddress = `${placeName}, ${address}`;
    scope.newLocation = L.latLng(lat, lng);
    
    // Update preview marker and map
    if (scope.previewMarker) {
      scope.previewMarker.setLatLng(scope.newLocation);
      map.setView(scope.newLocation, 17);
    }
    
    // Enable confirm button
    if (scope.confirmBtn) {
      scope.confirmBtn.style.opacity = '1';
      scope.confirmBtn.style.pointerEvents = 'auto';
    }
    
    console.log('[LocationIQ] New location set:', scope.newLocation);
    console.log('[LocationIQ] New address:', scope.newAddress);
    console.log('[LocationIQ] Confirm button enabled');
  }
  
  // Hide dropdown
  dropdown.style.display = 'none';
}

// Update selection in dropdown
function updateSelection(items, selectedIndex) {
  items.forEach((item, index) => {
    if (index === selectedIndex) {
      item.style.backgroundColor = '#003300';
      item.style.color = '#00ff00';
    } else {
      item.style.backgroundColor = 'transparent';
      item.style.color = '#00ff00';
    }
  });
}

async function startAddressSearch(callId, originalMarker, modal) {
  modal.remove();

  if (!markers[callId] || !allMarkers[callId]) {
    showNotification('Marker data not found', 'error');
    return;
  }

  const callData = allMarkers[callId];
  const transcription = callData.transcription || 'No transcription available';
  const category = callData.category || 'OTHER';
  const originalLocation = {
    lat: originalMarker.getLatLng().lat,
    lng: originalMarker.getLatLng().lng
  };

  markerGroups.removeLayer(originalMarker);

  const previewIcon = L.divIcon({
    className: 'preview-marker',
    html: `<div class="marker-pulse" style="
      width: 20px;
      height: 20px;
      background: rgba(0, 255, 0, 0.6);
      border: 2px solid #00ff00;
      border-radius: 50%;
      animation: pulse 1.5s infinite;
    "></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });

  const previewMarker = L.marker(originalMarker.getLatLng(), {
    icon: previewIcon,
    draggable: false,
    opacity: 1
  }).addTo(map);

  const banner = document.createElement('div');
  banner.className = 'address-search-banner';
  banner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0;
    background-color: rgba(0, 0, 0, 0.9);
    color: #00ff00; padding: 15px; text-align: center; z-index: 2000;
    font-family: 'Share Tech Mono', monospace;
    border-bottom: 2px solid #00ff00;
    box-shadow: 0 0 10px rgba(0, 255, 0, 0.5);
  `;

  banner.innerHTML = `
    <div style="margin-bottom: 10px;"><strong>🔍 Search Address</strong></div>
    <div style="margin-bottom: 15px; padding: 10px; background-color: rgba(0, 51, 0, 0.7); border: 1px solid rgba(0, 255, 0, 0.3); border-radius: 4px; text-align: left; max-height: 60px; overflow-y: auto;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="color: #00ccff; font-weight: bold;">${category}</span>
        <span style="flex: 1; color: #00ff00; overflow: hidden; text-overflow: ellipsis;">${transcription}</span>
      </div>
    </div>
    <div id="address-search-container" style="display: flex; justify-content: center; margin-bottom: 10px; padding: 0 15px;">
      <!-- Autocomplete element will be dynamically inserted here -->
    </div>
    <div style="display: flex; justify-content: center; gap: 10px;">
      <button id="confirm-address" style="
        background-color: #003300; color: #00ff00;
        border: 1px solid #00ff00; padding: 8px 16px;
        cursor: pointer; border-radius: 4px;
        font-family: 'Share Tech Mono', monospace;
        opacity: 0.5; pointer-events: none;
      ">Confirm New Location</button>
      <button id="cancel-address-search" style="
        background-color: #330000; color: #ff0000;
        border: 1px solid #ff0000; padding: 8px 16px;
        cursor: pointer; border-radius: 4px;
        font-family: 'Share Tech Mono', monospace;
      ">Cancel</button>
    </div>
  `;

  document.body.appendChild(banner);

  const confirmBtn = document.getElementById('confirm-address');
  let newLocation = previewMarker.getLatLng();
  let newAddress = '';

  try {
    // Create input element for autocomplete
    const searchContainer = document.getElementById('address-search-container');
    const inputElement = document.createElement('input');
    inputElement.type = 'text';
    inputElement.placeholder = 'Enter address...';
    inputElement.style.cssText = `
      width: 100%;
      padding: 8px 10px;
      background-color: #000;
      color: #00ff00;
      border: 1px solid #00ff00;
      border-radius: 4px;
      font-family: 'Share Tech Mono', monospace;
      font-size: 14px;
      box-sizing: border-box;
    `;
    searchContainer.appendChild(inputElement);

    // Initialize autocomplete based on available providers
    let autocompleteProvider = null;
    let autocompleteDropdown = null;

    // Address autocomplete now goes through the server-side proxy (/api/geocode/search)
    // so API keys never reach the browser. We use the dropdown for whichever
    // provider the server has configured.
    const googleAvailable = false; // keys are no longer exposed to the client
    const locationiqAvailable = !!appConfig.geocoding.provider;

    if (googleAvailable) {
      console.log('[Address Search] Using Google Places Autocomplete');
      autocompleteProvider = 'google';
      
      // Create Google Places autocomplete
      const autocomplete = new google.maps.places.Autocomplete(inputElement, {
        componentRestrictions: { country: "us" },
        fields: ['geometry', 'formatted_address']
      });

      // Add listener for place selection
      autocomplete.addListener('place_changed', () => {
        console.log('[Address Search] Google place changed event triggered');
        const place = autocomplete.getPlace();
        console.log('[Address Search] Selected Google place:', place);
        
        if (!place.geometry || !place.geometry.location) {
          console.error('[Address Search] No geometry data in Google place:', place);
          showNotification('No location data available for selected place.', 'error');
          return;
        }

        newAddress = place.formatted_address;
        newLocation = L.latLng(
          place.geometry.location.lat(),
          place.geometry.location.lng()
        );

        console.log('[Address Search] New location set:', newLocation);
        console.log('[Address Search] New address:', newAddress);

        previewMarker.setLatLng(newLocation);
        map.setView(newLocation, 17);
        confirmBtn.style.opacity = '1';
        confirmBtn.style.pointerEvents = 'auto';
        
        console.log('[Address Search] Confirm button enabled');
      });

    } else if (locationiqAvailable) {
      console.log('[Address Search] Using LocationIQ Autocomplete');
      autocompleteProvider = 'locationiq';
      
      // Create scope object to pass variables
      const scope = { newAddress, newLocation, previewMarker, confirmBtn };
      
      // Create LocationIQ autocomplete dropdown
      autocompleteDropdown = createLocationIQDropdown(inputElement, scope);
      
    } else {
      console.error('[Address Search] No autocomplete providers available');
      showNotification("No address search providers available. Please check API configuration.", "error");
      banner.remove();
      markerGroups.addLayer(originalMarker);
      return;
    }

    // Focus the input
    inputElement.focus();

    // Add a small delay to ensure autocomplete is ready
    setTimeout(() => {
      if (inputElement) {
        inputElement.focus();
      }
    }, 100);

  } catch (error) {
    console.error("Error loading address search component:", error);
    showNotification("Could not load address search component.", "error");
    banner.remove();
    markerGroups.addLayer(originalMarker);
    return;
  }

  function getOriginalAddress(lat, lng) {
    // Try Google first if available, then LocationIQ as fallback
    if (appConfig.geocoding.googleApiKey) {
      return fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${appConfig.geocoding.googleApiKey}`)
        .then(res => res.json())
        .then(data => {
          if (data.results && data.results.length > 0) {
            return data.results[0].formatted_address;
          } else {
            // Fallback to LocationIQ if Google returns no results
            return getLocationIQReverseGeocode(lat, lng);
          }
        })
        .catch(err => {
          console.error('Google reverse geocode error:', err);
          // Fallback to LocationIQ
          return getLocationIQReverseGeocode(lat, lng);
        });
    } else if (appConfig.geocoding.locationiqApiKey) {
      return getLocationIQReverseGeocode(lat, lng);
    } else {
      return Promise.resolve(`Unknown (${lat}, ${lng})`);
    }
  }

  function getLocationIQReverseGeocode(lat, lng) {
    const params = new URLSearchParams({
      key: appConfig.geocoding.locationiqApiKey,
      lat: lat,
      lon: lng,
      format: 'json'
    });
    
    return fetch(`https://us1.locationiq.com/v1/reverse?${params}`)
      .then(res => res.json())
      .then(data => {
        if (data.display_name) {
          return data.display_name;
        } else {
          return `Unknown (${lat}, ${lng})`;
        }
      })
      .catch(err => {
        console.error('LocationIQ reverse geocode error:', err);
        return `Unknown (${lat}, ${lng})`;
      });
  }

  function logCorrection(originalAddress, newAddress) {
    const logData = {
      timestamp: new Date().toISOString(),
      callId,
      category,
      transcription,
      originalLocation,
      originalAddress,
      newLocation: {
        lat: newLocation.lat,
        lng: newLocation.lng
      },
      newAddress,
      action: 'location_correction'
    };

    fetch('/api/log/correction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(logData)
    })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          console.log('Correction logged');
        } else {
          console.error('Logging failed:', data.error);
        }
      })
      .catch(err => {
        console.error('Log error:', err);
      });
  }

  confirmBtn.addEventListener('click', () => {
    if (confirmBtn.style.pointerEvents === 'none') return;

    confirmBtn.textContent = 'Updating...';
    confirmBtn.disabled = true;

    getOriginalAddress(originalLocation.lat, originalLocation.lng)
      .then(originalAddress => {
        return fetch(`/api/markers/${callId}/location`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lat: newLocation.lat,
            lon: newLocation.lng
          })
        })
        .then(res => res.json())
        .then(() => {
          originalMarker.setLatLng(newLocation);
          markerGroups.addLayer(originalMarker);
          if (markers[callId]?.pulseMarker) {
            markers[callId].pulseMarker.setLatLng(newLocation);
          }
          logCorrection(originalAddress, newAddress || 'Unknown');
          map.removeLayer(previewMarker);
          banner.remove();
          showNotification('Marker location updated successfully', 'success');
          if (document.getElementById('enable-heatmap').checked) {
            updateHeatmap();
          }
          // Update counts as marker location changed but it's still visible
          updateCategoryCounts();
        });
      })
      .catch(err => {
        console.error('Update error:', err);
        showNotification('Error updating marker location', 'error');
        markerGroups.addLayer(originalMarker);
      })
      .finally(() => {
        map.removeLayer(previewMarker);
        banner.remove();
      });
  });

  document.getElementById('cancel-address-search').addEventListener('click', () => {
    map.removeLayer(previewMarker);
    banner.remove();
    markerGroups.addLayer(originalMarker);
  });
}
// Helper function for reverse geocoding
function getOriginalAddress(lat, lng) {
  return fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${appConfig.geocoding.googleApiKey}`)
    .then(res => res.json())
    .then(data => {
      if (data.results && data.results.length > 0) {
        return data.results[0].formatted_address;
      } else {
        return `Unknown (${lat}, ${lng})`;
      }
    })
    .catch(err => {
      console.error('Reverse geocode error:', err);
      return `Unknown (${lat}, ${lng})`;
    });
}

function deleteMarker(callId, marker, modal) {
  const markerData = allMarkers[callId];
  const originalLocation = {
    lat: marker.getLatLng().lat,
    lng: marker.getLatLng().lng
  };

  // Helper to handle actual deletion process
  const performDeletion = () => {
    fetch(`/api/markers/${callId}`, {
      method: 'DELETE'
    })
    .then(response => response.json())
    .then(data => {
      // Remove pulsing effect if exists
      if (markers[callId] && markers[callId].pulseMarker) {
        map.removeLayer(markers[callId].pulseMarker);
      }

      // Remove from newestCallIds array if present
      const indexInNewest = newestCallIds.indexOf(callId);
      if (indexInNewest > -1) {
        newestCallIds.splice(indexInNewest, 1);
      }

      // Remove marker and cleanup
      markerGroups.removeLayer(marker);
      delete markers[callId];
      delete allMarkers[callId];
      modal.remove();

      // Show success notification
      showNotification('Marker deleted successfully', 'success');

      // Update heatmap if active
      if (document.getElementById('enable-heatmap').checked) {
        updateHeatmap();
      }

      // Update counts and sidebar
      updateCategoryCounts();

      // If a marker in the newest list was deleted, update pulsing markers
      if (indexInNewest > -1) {
        loadNewNewestMarker(); // This internally calls updatePulsingMarkers
      }
    })
    .catch(error => {
      console.error('Error deleting marker:', error);
      showNotification('Error deleting marker', 'error');
    });
  };

  // Try to log the deletion first
  getOriginalAddress(originalLocation.lat, originalLocation.lng)
    .then(address => {
      logDeletion(callId, markerData, originalLocation, address);
      performDeletion();
    })
    .catch(error => {
      console.error('Error getting address for deletion log:', error);
      performDeletion(); // Continue deletion even if address fails
    });
}

function logDeletion(callId, markerData, location, address) {
  const timestamp = new Date().toISOString();
  const logData = {
    timestamp: timestamp,
    callId: callId,
    category: markerData?.category || 'UNKNOWN',
    transcription: markerData?.transcription || 'No transcription available',
    location: location, // Use 'location' as expected by the new endpoint
    address: address,   // Use 'address' as expected by the new endpoint
    action: 'marker_deletion'
  };

  fetch('/api/log/deletion', { // Changed endpoint to /api/log/deletion
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(logData)
  })
  .then(response => response.json())
  .then(data => {
    if (data.success) {
      console.log('Deletion logged successfully to server');
    } else {
      console.error('Error logging deletion:', data.error);
    }
  })
  .catch(error => {
    console.error('Error sending deletion log to server:', error);
  });
}


// Add this helper function to load a new marker to the newest list if needed
function loadNewNewestMarker() {
  if (newestCallIds.length < MAX_PULSING_MARKERS) {
    // Find the next newest visible marker not already in the list
    const allCallIds = Object.keys(allMarkers);
    
    // Sort by timestamp (newest first)
    allCallIds.sort((a, b) => {
      const timeA = new Date(allMarkers[a].timestamp);
      const timeB = new Date(allMarkers[b].timestamp);
      return timeB - timeA;
    });
    
    // Find the first marker that isn't already in newestCallIds
    for (const callId of allCallIds) {
      if (!newestCallIds.includes(callId) && allMarkers[callId].visible) {
        newestCallIds.push(callId);
        // Add pulsing effect to this marker
        addPulsingEffectToMarker(callId);
        break; // Only need to add one
      }
    }
  }
  
  // Update all pulsing markers
  updatePulsingMarkers();
}

function startMarkerRelocation(callId, originalMarker, modal) {
  modal.remove();
  
  // Remove original marker from map temporarily
  markerGroups.removeLayer(originalMarker);

  // Create a draggable preview marker with pulsing effect
  const previewIcon = L.divIcon({
    className: 'preview-marker',
    html: `<div class="marker-pulse" style="
      width: 20px;
      height: 20px;
      background: rgba(0, 255, 0, 0.6);
      border: 2px solid #00ff00;
      border-radius: 50%;
      animation: pulse 1.5s infinite;
    "></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });

  const previewMarker = L.marker(originalMarker.getLatLng(), {
    icon: previewIcon,
    draggable: true,
    opacity: 1
  }).addTo(map);

  // Add CSS for pulsing animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulse {
      0% {
        box-shadow: 0 0 0 0 rgba(0, 255, 0, 0.7);
      }
      70% {
        box-shadow: 0 0 0 15px rgba(0, 255, 0, 0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(0, 255, 0, 0);
      }
    }
    .preview-marker {
      cursor: move;
    }
    .marker-pulse {
      transition: transform 0.2s;
    }
    .preview-marker:hover .marker-pulse {
      transform: scale(1.2);
    }
  `;
  document.head.appendChild(style);

  // Show instruction banner
  const banner = document.createElement('div');
  banner.className = 'relocation-banner';
  banner.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    background-color: rgba(0, 0, 0, 0.9);
    color: #00ff00;
    padding: 15px;
    text-align: center;
    z-index: 2000;
    font-family: 'Share Tech Mono', monospace;
    border-bottom: 2px solid #00ff00;
    box-shadow: 0 0 10px rgba(0, 255, 0, 0.5);
  `;

  banner.innerHTML = `
    <div style="margin-bottom: 10px;">
      <strong>🎯 Relocate Marker</strong><br>
      <span style="font-size: 0.9em;">
        <span class="ellipsis" style="color: #00ff00;">Drag the pulsing marker or click anywhere on the map to set new location</span>
      </span>
    </div>
    <div style="display: flex; justify-content: center; gap: 10px;">
      <button id="confirm-location" style="
        background-color: #003300;
        color: #00ff00;
        border: 1px solid #00ff00;
        padding: 8px 16px;
        cursor: pointer;
        border-radius: 4px;
        font-family: 'Share Tech Mono', monospace;
      ">Confirm New Location</button>
      <button id="cancel-relocation" style="
        background-color: #330000;
        color: #ff0000;
        border: 1px solid #ff0000;
        padding: 8px 16px;
        cursor: pointer;
        border-radius: 4px;
        font-family: 'Share Tech Mono', monospace;
      ">Cancel</button>
    </div>
  `;

  document.body.appendChild(banner);

  // Keep map dragging enabled but highlight draggable marker
  previewMarker.on('mouseover', function() {
    this.getElement().style.cursor = 'move';
  });

  previewMarker.on('mouseout', function() {
    this.getElement().style.cursor = '';
  });

  // Store current location
  let newLocation = previewMarker.getLatLng();

  // Update location when marker is dragged
  previewMarker.on('dragstart', () => {
    banner.querySelector('span.ellipsis').textContent = 'Release to set new location...';
  });

  previewMarker.on('dragend', (e) => {
    newLocation = e.target.getLatLng();
    banner.querySelector('span.ellipsis').textContent = 'Drag the pulsing marker or click anywhere on the map to set new location';
  });

  // Update location when map is clicked
  function handleMapClick(e) {
    newLocation = e.latlng;
    previewMarker.setLatLng(newLocation);
  }
  map.on('click', handleMapClick);

  // Handle confirmation
  document.getElementById('confirm-location').addEventListener('click', () => {
    const confirmButton = document.getElementById('confirm-location');
    confirmButton.textContent = 'Updating...';
    confirmButton.style.opacity = '0.5';
    confirmButton.disabled = true;

    fetch(`/api/markers/${callId}/location`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        lat: newLocation.lat, 
        lon: newLocation.lng 
      })
    })
    .then(response => response.json())
    .then(data => {
      // Update original marker position
      originalMarker.setLatLng(newLocation);
      markerGroups.addLayer(originalMarker);
      
      // Clean up
      map.removeLayer(previewMarker);
      banner.remove();
      style.remove();
      map.off('click', handleMapClick);
      
      showNotification('Marker location updated successfully', 'success');
      
      if (document.getElementById('enable-heatmap').checked) {
        updateHeatmap();
      }
    })
    .catch(error => {
      console.error('Error updating marker location:', error);
      showNotification('Error updating marker location', 'error');
      markerGroups.addLayer(originalMarker);
    })
    .finally(() => {
      map.removeLayer(previewMarker);
      banner.remove();
      style.remove();
      map.off('click', handleMapClick);
    });
  });

  // Handle cancellation
  document.getElementById('cancel-relocation').addEventListener('click', () => {
    map.removeLayer(previewMarker);
    banner.remove();
    style.remove();
    map.off('click', handleMapClick);
    markerGroups.addLayer(originalMarker);
  });
}

// Get Marker Icon Based on Call Data
function getMarkerIcon(talkGroupName, talkGroupId, audioFilePath) {
    console.log('getMarkerIcon input:', { talkGroupName, talkGroupId, audioFilePath });

    talkGroupName = talkGroupName || '';
    audioFilePath = audioFilePath || '';

    // Check audio path classifications first
    if (audioFilePath) {
        // Check for police audio paths
        for (const pattern of appConfig.markerClassification.audioPaths.police) {
            if (audioFilePath.includes(pattern)) {
                return customIcons.pd;
            }
        }
        
        // Check for fire audio paths
        for (const pattern of appConfig.markerClassification.audioPaths.fire) {
            if (audioFilePath.includes(pattern)) {
                return customIcons.fire;
            }
        }
    }

    // Check talk group name classifications
    if (talkGroupName) {
        // Check for police talk groups
        for (const pattern of appConfig.markerClassification.police) {
            if (talkGroupName === pattern || talkGroupName.includes(pattern)) {
                return customIcons.pd;
            }
        }
        
        // Check for fire talk groups
        for (const pattern of appConfig.markerClassification.fire) {
            if (talkGroupName === pattern || talkGroupName.includes(pattern)) {
                return customIcons.fire;
            }
        }
    }

    // Default icon if no matches
    return customIcons.default;
}

// Smoothly Pan and Zoom to Marker with Animation Queue
function smoothFlyToNewMarker(marker, callback) {
    console.log('[Track New Call] smoothFlyToNewMarker started.');
    const maxZoom = map.getMaxZoom();
    const minZoom = map.getMinZoom();
    const targetZoom = Math.min(appConfig.animation.targetZoom, maxZoom);

    // Disable map interactions during animation
    map.dragging.disable();
    map.scrollWheelZoom.disable();
    map.doubleClickZoom.disable();
    map.boxZoom.disable();
    map.keyboard.disable();
    if (map.tap) map.tap.disable();

    // Step 1: Always zoom out to configured level (or minZoom if it's higher)
    const zoomOutLevel = Math.max(appConfig.animation.zoomOutLevel, minZoom);
    map.flyTo(map.getCenter(), zoomOutLevel, { duration: appConfig.animation.duration });

    map.once('moveend', function() {
        // Step 2: Fly to the marker's location at zoom out level
        map.flyTo(marker.getLatLng(), zoomOutLevel, { duration: appConfig.animation.duration });

        map.once('moveend', function() {
            // Step 3: Zoom in to the target zoom level
            map.flyTo(marker.getLatLng(), targetZoom, { duration: appConfig.animation.duration });

            map.once('moveend', function() {
                console.log('[Track New Call] Final animation step ended. Executing callback.');
                callback();

                // Re-enable map interactions
                map.dragging.enable();
                map.scrollWheelZoom.enable();
                map.doubleClickZoom.enable();
                map.boxZoom.enable();
                map.keyboard.enable();
                if (map.tap) map.tap.enable();
            });
        });
    });
}

function handleMarkerVisibility(marker) {
    console.log('[Track New Call] handleMarkerVisibility started.');
    const visibleParent = markerGroups.getVisibleParent(marker);

    if (visibleParent === marker) {
        // Marker is visible, open popup
        openMarkerPopup(marker);
        playAudioForMarker(marker);
    } else if (visibleParent instanceof L.MarkerCluster) {
        // Marker is in a cluster
        visibleParent.spiderfy();
        
        // Wait for spiderfy animation to complete
        setTimeout(() => {
            openMarkerPopup(marker);
            playAudioForMarker(marker);
        }, 300);
    } else {
        console.error('Unexpected state: marker is neither visible nor in a cluster');
    }
}

function playAudioForMarker(marker) {
    if (!isNewCallAudioMuted) {
        const callId = getCallIdFromMarker(marker);
        if (callId && wavesurfers[callId]) {
            wavesurfers[callId].play();
            const playPauseButton = document.querySelector(`.play-pause[data-call-id="${callId}"]`);
            if (playPauseButton) {
                playPauseButton.textContent = 'Pause';
            }
        }
    }
}

function openMarkerPopup(marker) {
    // Prevent recursive calls
    if (marker.isPopupOpen()) {
        return;
    }

    // Check if the marker is visible and not clustered
    const visibleParent = markerGroups.getVisibleParent(marker);

    if (visibleParent === marker) {
        // Marker is already visible and not clustered; open the popup
        marker.openPopup();
    } else {
        // Marker is clustered or not visible; attempt to zoom to show it
        // Ensure we don't exceed max zoom levels
        const currentZoom = map.getZoom();
        const maxZoom = map.getMaxZoom();

        // If we're already at max zoom, spiderfy the cluster
        if (currentZoom >= maxZoom) {
            // Spiderfy the cluster to show individual markers
            visibleParent.spiderfy();
            // Optionally, open the popup after spiderfying
            marker.openPopup();
        } else {
            // Attempt to zoom in to show the marker
            markerGroups.zoomToShowLayer(marker, function() {
                marker.openPopup();
            });
        }
    }
}

function processNextAnimation() {
    if (animationQueue.length === 0) {
        isAnimating = false;
        return;
    }
    console.log('[Track New Call] processNextAnimation dequeuing and starting animation.');
    isAnimating = true;
    const { marker, callback } = animationQueue.shift();
    smoothFlyToNewMarker(marker, () => {
        callback();
        processNextAnimation();
    });
}

function enqueueAnimation(marker, callback) {
    console.log('[Track New Call] enqueueAnimation adding item to queue.');
    animationQueue.push({ marker, callback });
    if (!isAnimating) {
        processNextAnimation();
    }
}

// New function to replace setupMuteButton
function setupCallControls() {
    const muteCheckbox = document.getElementById('mute-new-calls');
    const trackCheckbox = document.getElementById('track-new-calls');
    
    if (muteCheckbox) {
        muteCheckbox.addEventListener('change', function() {
            isNewCallAudioMuted = this.checked;
            console.log(`New call audio muted: ${isNewCallAudioMuted}`);
        });
    } else {
        console.error('Mute new calls checkbox not found');
    }
    
    if (trackCheckbox) {
        trackCheckbox.checked = isTrackingNewCalls; // Set initial state
        trackCheckbox.addEventListener('change', function() {
            isTrackingNewCalls = this.checked;
            console.log(`Tracking new calls: ${isTrackingNewCalls}`);
        });
    } else {
        console.error('Track new calls checkbox not found');
    }
}

function toggleNewCallAudioMute() {
    isNewCallAudioMuted = !isNewCallAudioMuted;
    const muteButton = document.getElementById('mute-new-calls');
    muteButton.textContent = isNewCallAudioMuted ? 'Unmute New Calls' : 'Mute New Calls';
    console.log(`New call audio muted: ${isNewCallAudioMuted}`);
}

function playNewCallSound() {
    if (!isNewCallAudioMuted) {
        const audio = new Audio(appConfig.audio.notificationSound);
        audio.play().catch(error => console.error('Error playing notification sound:', error));
    }
}

function playAudio(audioId) {
    if (!isNewCallAudioMuted && wavesurfers[audioId]) {
        wavesurfers[audioId].play();
    } else {
        console.log('New call audio is muted or WaveSurfer not initialized. Audio not played:', audioId);
    }
}

function getAdditionalTranscriptions(callId, skip, container, button) {
    fetch(`/api/additional-transcriptions/${callId}?skip=${skip}`)
        .then(response => response.json())
        .then(data => {
            if (data.length === 0) {
                button.style.display = 'none';
                if (skip === 0) {
                    container.innerHTML = '<p>No additional calls from this talk group.</p>';
                }
            } else {
                const newContent = data.map(trans => `
                    <div class="additional-transcription">
                        <small>${formatTimestamp(trans.timestamp)}</small><br>
                        <p>${trans.transcription}</p>
                        <div id="waveform-${trans.id}" class="waveform"></div>
                        <div class="audio-controls">
                            <button class="play-pause" data-call-id="${trans.id}" aria-label="Play audio for call ${trans.id}">Play</button>
                            <input type="range" class="volume" min="0" max="1" step="0.1" value="1" data-call-id="${trans.id}" aria-label="Volume control for call ${trans.id}">
                        </div>
                    </div>
                `).join('');
                
                container.innerHTML += newContent;
                button.setAttribute('data-skip', skip + data.length);

                // Initialize WaveSurfer for each new transcription
                data.forEach(trans => {
                    initWaveSurfer(trans.id, `/audio/${trans.id}`, additionalWavesurfers); // Corrected: Use trans.id and pass store
                });
            }
        })
        .catch(error => {
            console.error('Error fetching additional transcriptions:', error);
            container.innerHTML += '<p>Error fetching additional information.</p>';
        });
}

function clearMarkers() {
    console.log(`[DEBUG] clearMarkers started`);
    console.log(`[DEBUG] Current markers count: ${Object.keys(markers).length}`);
    console.log(`[DEBUG] Current allMarkers count: ${Object.keys(allMarkers).length}`);
    
    // First, remove all pulse markers
    Object.keys(markers).forEach(callId => {
        if (markers[callId] && markers[callId].pulseMarker) {
            map.removeLayer(markers[callId].pulseMarker);
        }
    });
    
    // Then clear all regular markers
    markerGroups.clearLayers();
    Object.keys(markers).forEach(key => delete markers[key]);
    
    // Clear allMarkers object as well
    Object.keys(allMarkers).forEach(key => delete allMarkers[key]);

    // Clear heatmap data if it exists
    if (heatmapLayer) {
        heatmapLayer.setLatLngs([]);
    }
    
    console.log(`[DEBUG] clearMarkers completed`);
    console.log(`[DEBUG] Markers count after clear: ${Object.keys(markers).length}`);
    console.log(`[DEBUG] allMarkers count after clear: ${Object.keys(allMarkers).length}`);
}

function loadCalls(hours) {
    console.log(`[DEBUG] loadCalls started with hours: ${hours}`);
    console.log(`[DEBUG] Current allMarkers count before fetch: ${Object.keys(allMarkers).length}`);
    
    fetch(`/api/calls?hours=${hours}`)
        .then(response => response.json())
        .then(calls => {
            console.log(`[DEBUG] Received ${calls.length} calls from server`);
            if (calls.length > 0) {
                console.log(`[DEBUG] Oldest call received: ${calls[calls.length - 1].timestamp}`);
                console.log(`[DEBUG] Newest call received: ${calls[0].timestamp}`);
            }
            
            // Clear existing markers
            console.log(`[DEBUG] Clearing existing markers...`);
            clearMarkers();
            console.log(`[DEBUG] Markers cleared. allMarkers count after clear: ${Object.keys(allMarkers).length}`);
            
            // Reset newest call IDs
            newestCallIds = [];
            
            // Filter for valid calls
            const validCalls = calls.filter(isValidCall);
            console.log(`[DEBUG] ${validCalls.length} valid calls after filtering`);
            
            // Sort calls by timestamp (newest first)
            validCalls.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            
            // Add all markers to the map
            console.log(`[DEBUG] Adding ${validCalls.length} markers to map...`);
            validCalls.forEach(call => addMarker(call));
            console.log(`[DEBUG] Markers added. allMarkers count after adding: ${Object.keys(allMarkers).length}`);
            
            // Get the newest 3 call IDs
            newestCallIds = validCalls.slice(0, MAX_PULSING_MARKERS).map(call => call.id);
            console.log(`[DEBUG] Newest call IDs: ${newestCallIds}`);
            
            // Apply pulsing effect to newest calls
            updatePulsingMarkers();
            
            // Apply any filters
            applyFilters();
            
            // Update heatmap if enabled
            if (document.getElementById('enable-heatmap').checked) {
                updateHeatmap();
            }
            
            // Fit map to markers
            fitMapToMarkers();
            
            console.log(`[DEBUG] loadCalls completed successfully`);
        })
        .catch(error => {
            console.error('[DEBUG] Error loading calls:', error);
        });
}

function fitMapToMarkers() {
    const markerArray = Object.values(allMarkers)
        .filter(obj => obj.visible)
        .map(obj => obj.marker);
    if (markerArray.length > 0) {
        const group = L.featureGroup(markerArray);
        map.fitBounds(group.getBounds().pad(0.1));
    } else {
        console.log('No markers to fit');
    }
}

function formatTimestamp(timestamp) {
    // Multiply Unix timestamp by 1000
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    // Format the simple timestamp in the configured time zone
    const options = { 
        timeZone: appConfig.map.timeZone,
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true
    };
    const simpleTimestamp = date.toLocaleString('en-US', options);
    let relativeTime;
    if (diffDays === 0) {
        if (diffHours === 0) {
            relativeTime = `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
        } else {
            relativeTime = `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        }
        return `Today, ${relativeTime} (${simpleTimestamp})`;
    } else if (diffDays === 1) {
        return `Yesterday, ${simpleTimestamp}`;
    } else {
        const fullOptions = { 
            timeZone: appConfig.map.timeZone,
            year: 'numeric', 
            month: 'short', 
            day: 'numeric', 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: true
        };
        return date.toLocaleString('en-US', fullOptions);
    }
}

function setupSearch() {
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', function(event) {
            currentSearchTerm = event.target.value.trim().toLowerCase();
            applyFilters();
        });
    } else {
        console.error('Search input element not found');
    }
}

function applyFilters() {
    let visibleMarkers = 0;
    let lastVisibleMarker = null;

    const now = new Date();
    const filterTime = new Date(now.getTime() - timeRangeHours * 60 * 60 * 1000);

    console.log(`Filtering calls since: ${filterTime.toISOString()}`);
    console.log(`Total markers before filtering: ${Object.keys(allMarkers).length}`);

    // Process each marker
    Object.keys(allMarkers).forEach(callId => {
        const { marker, transcription, category, timestamp } = allMarkers[callId];
        const callTime = new Date(timestamp * 1000);
        const isWithinTimeRange = callTime >= filterTime;
        
        // Check if search term matches transcription or category
        const matchesSearch = 
            transcription.toLowerCase().includes(currentSearchTerm.toLowerCase()) || 
            (category && category.toLowerCase().includes(currentSearchTerm.toLowerCase()));
        
        // Check if category filter matches
        const matchesCategory = !selectedCategory || category === selectedCategory;
            
        const shouldDisplay = isWithinTimeRange && matchesSearch && matchesCategory;

        if (shouldDisplay) {
            markerGroups.addLayer(marker);
            allMarkers[callId].visible = true;
            visibleMarkers++;
            lastVisibleMarker = marker;
            
            // If this is a newest call with pulsing effect, make sure it's visible
            if (markers[callId] && markers[callId].pulseMarker && newestCallIds.includes(callId)) {
                if (!map.hasLayer(markers[callId].pulseMarker)) {
                    map.addLayer(markers[callId].pulseMarker);
                }
            }
        } else {
            markerGroups.removeLayer(marker);
            allMarkers[callId].visible = false;
            
            // If this marker has a pulsing effect, remove it from map
            if (markers[callId] && markers[callId].pulseMarker) {
                map.removeLayer(markers[callId].pulseMarker);
            }
        }
    });

    console.log(`Visible markers after filtering: ${visibleMarkers}`);
    
    // Update category counts and sidebar *after* visibility is set
    updateCategoryCounts();

    // Update heatmap if active
    if (document.getElementById('enable-heatmap').checked) {
        updateHeatmap();
    }

    // Fit map to visible markers
    fitMapToMarkers();

    // If only one marker is visible, open its popup
    if (visibleMarkers === 1 && lastVisibleMarker) {
      // Add a small delay to prevent race condition with WaveSurfer init
      setTimeout(() => {
          // Ensure the marker still exists and is visible before opening
          if (allMarkers[getCallIdFromMarker(lastVisibleMarker)]?.visible) {
              openMarkerPopup(lastVisibleMarker);
          }
      }, 500); // 500ms delay
    }
}


function isMarkerWithinTimeRange(timestamp) {
    const callTimestamp = new Date(timestamp);
    const sinceTimestamp = new Date(Date.now() - timeRangeHours * 60 * 60 * 1000);
    return callTimestamp >= sinceTimestamp;
}

function getCallIdFromMarker(marker) {
    for (const [callId, data] of Object.entries(allMarkers)) {
        if (data.marker === marker) {
            console.log(`Found callId: ${callId} for marker.`);
            return callId;
        }
    }
    console.error('Could not find call ID for marker:', marker);
    return null;
}

function setupHeatmapControls() {
    const heatmapCheckbox = document.getElementById('enable-heatmap');
    const intensitySliderContainer = document.getElementById('heatmap-intensity-container');
    const intensitySlider = document.getElementById('heatmap-intensity');

    if (heatmapCheckbox && intensitySliderContainer && intensitySlider) {
        heatmapCheckbox.addEventListener('change', handleHeatmapToggle);

        // Set initial visibility of intensity slider container
        intensitySliderContainer.style.display = heatmapCheckbox.checked ? 'flex' : 'none';

        // Set initial fill for intensity slider
        updateSliderFill(intensitySlider);

        // Remove all existing event listeners by cloning the slider
        const newIntensitySlider = intensitySlider.cloneNode(true);
        intensitySlider.parentNode.replaceChild(newIntensitySlider, intensitySlider);
        
        // Add specific heatmap intensity handler - NOT volume related
        newIntensitySlider.addEventListener('input', function(e) {
            // IMPORTANT: Only handle heatmap intensity, NOT volume
            heatmapIntensity = parseInt(this.value, 10);
            console.log(`[HEATMAP] Intensity changed to ${heatmapIntensity}`);
            
            if (document.getElementById('enable-heatmap').checked) {
                updateHeatmap();
            }
            
            // Update slider fill visual only
            updateSliderFill(this);
        });

        console.log("[HEATMAP] Heatmap controls initialized correctly");
    } else {
        console.error('[HEATMAP] Heatmap control elements not found');
    }
}

// Fixed handleIntensityChange to ONLY affect heatmap, not volume
function handleIntensityChange(event) {
    // ONLY handle heatmap intensity here, NOT volume
    heatmapIntensity = parseInt(event.target.value, 10);
    console.log(`[HEATMAP] Intensity handler called with value: ${heatmapIntensity}`);
    
    if (document.getElementById('enable-heatmap').checked) {
        updateHeatmap();
    }
}

function handleHeatmapToggle(event) {
    const intensitySliderContainer = document.getElementById('heatmap-intensity-container');
    if (event.target.checked) {
        intensitySliderContainer.style.display = 'flex';
        showHeatmap();
    } else {
        intensitySliderContainer.style.display = 'none';
        hideHeatmap();
    }
}

function showHeatmap() {
    // Collect data points from visible markers
    const heatData = [];

    Object.values(allMarkers).forEach(data => {
        if (data.visible) {
            const latlng = data.marker.getLatLng();
            heatData.push([latlng.lat, latlng.lng, heatmapIntensity]); // Use intensity value
        }
    });

    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
    }

    heatmapLayer = L.heatLayer(heatData, { 
        radius: appConfig.heatmap.radius, 
        blur: appConfig.heatmap.blur, 
        maxZoom: appConfig.heatmap.maxZoom 
    });
    heatmapLayer.addTo(map);
}

function hideHeatmap() {
    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
        heatmapLayer = null;
    }
}

function updateHeatmap() {
    if (!heatmapLayer) {
        showHeatmap();
        return;
    }

    const heatData = [];

    Object.values(allMarkers).forEach(data => {
        if (data.visible) {
            const latlng = data.marker.getLatLng();
            heatData.push([latlng.lat, latlng.lng, heatmapIntensity]); // Use intensity value
        }
    });

    heatmapLayer.setLatLngs(heatData);
}

function isMobile() {
    return window.innerWidth <= 768;
}

function disableMobileMapInteractions() {
    // Keep all touch-based interactions enabled
    map.dragging.enable();
    map.touchZoom.enable();
    map.doubleClickZoom.enable();  // Keep double tap zoom enabled
    
    // Only disable non-touch interactions
    map.boxZoom.disable();
    map.keyboard.disable();
}

function enableMobileMapInteractions() {
    map.dragging.enable();
    map.touchZoom.enable();
    map.doubleClickZoom.enable();
    map.scrollWheelZoom.enable();
    map.boxZoom.enable();
    map.keyboard.enable();
}

function handleWindowResize() {
    if (isMobile()) {
        disableMobileMapInteractions();
    } else {
        enableMobileMapInteractions();
    }
}

function isValidCall(call) {
    const lat = parseFloat(call.lat);
    const lon = parseFloat(call.lon);
    const isValid = (
        call &&
        !isNaN(lat) &&
        !isNaN(lon) &&
        lat >= -90 && lat <= 90 &&
        lon >= -180 && lon <= 180 &&
        call.audio_file_path &&
        call.transcription
    );
    if (!isValid) {
        console.log('Invalid call:', call);
    }
    return isValid;
}

// Initialize WaveSurfer
function initWaveSurfer(callId, audioUrl, wavesurferStore, onReadyCallback, containerSelector = null) {
    const containerId = containerSelector || `waveform-${callId}`;
    const containerElement = document.getElementById(containerId);

    // Check if container exists
    if (!containerElement) {
        console.warn(`WaveSurfer container #${containerId} not found for callId ${callId}. Skipping init.`);
        return;
    }

    // Destroy existing instance for this specific call ID *in this store* if it exists
    if (wavesurferStore[callId]) {
        try {
            wavesurferStore[callId].destroy();
        } catch (e) {
            // Be less verbose specifically for AbortError during cleanup
            if (e.name === 'AbortError') {
                 // console.warn(`Ignoring AbortError during destroy for ${callId}`); // Option to log silently
            } else {
                 console.warn(`Error destroying previous wavesurfer for ${callId}:`, e); // Log other errors
            }
        }
        delete wavesurferStore[callId];
    }

    try {
        // Create WaveSurfer instance
        wavesurferStore[callId] = WaveSurfer.create({
            container: `#${containerId}`, // Use the dynamic or default container ID
            waveColor: '#00ff00',
            progressColor: '#008000',
            cursorColor: '#ffffff',
            height: containerId.startsWith('tg-') ? 25 : 30, // Use smaller height for talkgroup modal
            normalize: true,
            backend: 'webaudio',
            volume: globalVolumeLevel, // Set initial volume from global setting
        });

        // console.log(`[Audio] Created new WaveSurfer instance for callId ${callId} with initial volume ${globalVolumeLevel}`); // REMOVED THIS LOG

        // Load audio file
        wavesurferStore[callId].load(audioUrl);

        // Find controls specific to this WaveSurfer instance (pop-up, modal, or dynamic content)
        let controlsContainer = containerElement.closest('.talkgroup-list-item, .custom-popup'); // Try standard parents first
        if (!controlsContainer) {
             // Fallback for dynamically added content (like "More Info") where the button might be a sibling or in a direct child
             controlsContainer = containerElement.parentElement.querySelector('.audio-controls') ? containerElement.parentElement : null;
        }
        
        if (!controlsContainer) {
            console.warn(`Could not find controls container for wavesurfer ${callId} using querySelector or closest.`);
            return;
        }
        // ADD LOG 1
        console.log(`[initWaveSurfer - ${callId}] Found controlsContainer:`, controlsContainer);

        const playPauseButton = controlsContainer.querySelector(`.play-pause[data-call-id="${callId}"]`);
        // ADD LOG 2
        console.log(`[initWaveSurfer - ${callId}] Found playPauseButton:`, playPauseButton);
        if (playPauseButton) {
            // Clone and replace to remove old listeners reliably
            const newButton = playPauseButton.cloneNode(true);
            playPauseButton.parentNode.replaceChild(newButton, playPauseButton);
            // ADD LOG 3
            console.log(`[initWaveSurfer - ${callId}] Adding click listener to button.`);
            newButton.addEventListener('click', function() {
                // ADD LOG 4
                console.log(`[Play Button Click - ${callId}] Clicked!`);
                // ADD LOG 5
                const instanceExists = !!wavesurferStore[callId];
                console.log(`[Play Button Click - ${callId}] Instance in store? ${instanceExists}`, wavesurferStore[callId]);
                
                if (!instanceExists) {
                    console.error(`[Play Button Click - ${callId}] CANNOT PLAY - Instance missing from store!`, wavesurferStore);
                    return; // Stop if instance is missing
                }

                if (wavesurferStore[callId].isPlaying()) {
                    wavesurferStore[callId].pause();
                    this.textContent = 'Play';
                } else {
                    // Pause all other playing wavesurfers in the *same* store
                    Object.keys(wavesurferStore).forEach(wsCallId => {
                        if (wsCallId !== callId.toString() && wavesurferStore[wsCallId] && wavesurferStore[wsCallId].isPlaying()) {
                            wavesurferStore[wsCallId].pause();
                            const otherButton = document.querySelector(`.play-pause[data-call-id="${wsCallId}"]`);
                            if (otherButton) otherButton.textContent = 'Play';
                        }
                    });

                    // Resume audio context if needed before playing
                    if (wavesurferStore[callId].backend && typeof wavesurferStore[callId].backend.getAudioContext === 'function') {
                        const audioContext = wavesurferStore[callId].backend.getAudioContext();
                        if (audioContext.state === 'suspended') {
                            audioContext.resume().then(() => {
                                console.log('[Audio] AudioContext resumed before playing wavesurfer audio');
                                wavesurferStore[callId].play();
                                this.textContent = 'Pause';
                            }).catch(e => {
                                console.error('[Audio] AudioContext resume failed:', e);
                                // Try to play anyway
                                wavesurferStore[callId].play();
                                this.textContent = 'Pause';
                            });
                        } else {
                            wavesurferStore[callId].play();
                            this.textContent = 'Pause';
                        }
                    } else {
                        wavesurferStore[callId].play();
                        this.textContent = 'Pause';
                    }
                }
            });
        }

        // WaveSurfer event listeners
        wavesurferStore[callId].on('ready', function() {
            // console.log(`WaveSurfer for callId ${callId} in container #${containerId} is ready.`); // REMOVED THIS LOG

            // Ensure volume is set correctly on ready
            try {
                // Use our global volume setter
                wavesurferStore[callId].setVolume(globalVolumeLevel);
                // console.log(`[VOLUME] Set volume for ready wavesurfer ${callId} to ${globalVolumeLevel}`); // REMOVED THIS LINE
            } catch (e) {
                console.error(`[VOLUME] Error setting volume for wavesurfer ${callId}:`, e);
            }

            if (onReadyCallback) onReadyCallback();
        });

        wavesurferStore[callId].on('finish', function() {
            const button = controlsContainer.querySelector(`.play-pause[data-call-id="${callId}"]`);
            if (button) {
                button.textContent = 'Play';
            }
        });

        wavesurferStore[callId].on('error', function(error) {
            // ADD Check: Ignore AbortError as it's likely due to rapid cleanup/re-init
            if (error && error.name === 'AbortError') {
                // console.log(`[WaveSurfer ${callId}] Ignoring AbortError during load.`); // Optional: log if needed
                return; // Stop processing this specific error
            }
            // Log and display other errors
            console.error(`WaveSurfer error for callId ${callId} in container #${containerId}:`, error);
            const errorMsg = document.createElement('small');
            errorMsg.textContent = ' Error loading audio.';
            errorMsg.style.color = 'red';
            containerElement.appendChild(errorMsg);
        });

    } catch (error) {
        console.error(`Failed to initialize WaveSurfer for callId ${callId}:`, error);
    }
}

// Modified to accept the specific wavesurfer store
function playWaveSurferAudio(callId, wavesurferStore, marker = null) {
    if (!wavesurferStore || !wavesurferStore[callId]) {
        console.error(`WaveSurfer instance not found for callId ${callId} in the provided store.`);
        return;
    }
    try {
        // Get the wavesurfer instance
        const wsInstance = wavesurferStore[callId];
        
        // Ensure the volume is set correctly before playing
        wsInstance.setVolume(globalVolumeLevel);
        console.log(`[VOLUME] Set volume for wavesurfer ${callId} to ${globalVolumeLevel} before playing`);
        
        // Ensure audio context is running (required after user interaction)
        if (wsInstance.backend && typeof wsInstance.backend.getAudioContext === 'function') {
            const audioContext = wsInstance.backend.getAudioContext();
            if (audioContext.state === 'suspended') {
                audioContext.resume().then(() => {
                    console.log('AudioContext resumed for playing');
                    wsInstance.play();
                }).catch(e => console.error('AudioContext resume failed:', e));
            } else {
                wsInstance.play();
            }
        } else {
            wsInstance.play(); // Fallback if context check fails
        }

        const controlsContainer = document.querySelector(`.talkgroup-list-item[data-call-id="${callId}"], .custom-popup`); // Find the right container
        if (controlsContainer) {
            const playPauseButton = controlsContainer.querySelector(`.play-pause[data-call-id="${callId}"]`);
            if (playPauseButton) {
                playPauseButton.textContent = 'Pause';
            }
        }

        if (marker) {
            marker.shouldPlayAudio = false; // Mark as played if triggered from marker
        }
        console.log(`Audio played for callId: ${callId}`);
    } catch (e) {
        console.error(`Failed to play audio for callId ${callId}:`, e);
    }
}

// NEW: Event handler wrapper for the history button
function handleShowTalkgroupHistory(event) {
    const button = event.target;
    const talkgroupId = button.getAttribute('data-talkgroup-id');
    const talkgroupName = button.getAttribute('data-talkgroup-name');
    const callIdToScrollTo = button.getAttribute('data-call-id'); // NEW

    if (talkgroupId) {
        showTalkgroupModal(parseInt(talkgroupId, 10), talkgroupName, callIdToScrollTo ? parseInt(callIdToScrollTo, 10) : null); // Pass callId
    } else {
        console.error("Talkgroup ID not found on button");
    }
}

// Global function to close the talkgroup modal
function closeTalkgroupModal() {
    const modal = document.getElementById('talkgroup-modal');
    const listElement = document.getElementById('talkgroup-list'); // Get list element
    if (modal) {
        modal.style.display = 'none';
    }
    // Remove scroll listener when closing
    if (listElement) {
        listElement.removeEventListener('scroll', handleTalkgroupScroll);
    }

    isTalkgroupModalOpen = false;
    currentOpenTalkgroupId = null;

    // Destroy all wavesurfers associated with this modal instance
    Object.keys(talkgroupModalWavesurfers).forEach(callId => {
        if (talkgroupModalWavesurfers[callId]) {
            talkgroupModalWavesurfers[callId].destroy();
        }
    });
    // Clear the object
    for (let key in talkgroupModalWavesurfers) {
        delete talkgroupModalWavesurfers[key];
    }
    console.log('Talkgroup modal closed and wavesurfers destroyed.');

    // Restore main mute state
    const mainMuteCheckbox = document.getElementById('mute-new-calls');
    if (mainMuteCheckbox && mainMuteCheckbox.checked !== originalMuteStateBeforeModal) {
        mainMuteCheckbox.checked = originalMuteStateBeforeModal;
        mainMuteCheckbox.dispatchEvent(new Event('change')); // Trigger state update
        console.log(`Restored main mute state to: ${originalMuteStateBeforeModal}`);
    }

    // Clear the polling interval when closing the modal
    if (talkgroupPollingInterval) {
        clearInterval(talkgroupPollingInterval);
        talkgroupPollingInterval = null;
    }
}

// NEW: Function to create a list item for the talkgroup modal
function createTalkgroupListItem(call) {
    const listItem = document.createElement('div');
    listItem.className = 'talkgroup-list-item';
    listItem.dataset.callId = call.id;

    listItem.innerHTML = `
        <span class="talkgroup-item-timestamp">${formatTimestamp(call.timestamp)}</span>
        <p class="talkgroup-item-transcription">${call.transcription || 'No transcription available.'}</p>
        <div class="talkgroup-item-audio">
            ${call.id ? `  
                <div id="tg-waveform-${call.id}" class="waveform"></div>
                <div class="audio-controls">
                    <button class="play-pause" data-call-id="${call.id}" aria-label="Play audio">Play</button>
                    <!-- REMOVED: <input type="range" class="volume" min="0" max="1" step="0.1" value="1" data-call-id="${call.id}" aria-label="Volume control"> -->
                </div>
            ` : '<small>No audio file.</small>'}
        </div>
    `;

    // Initialize WaveSurfer if audio exists (check based on ID)
    if (call.id) { // Corrected: Check for call.id
        // Use setTimeout to ensure the element is in the DOM before WaveSurfer tries to attach
        setTimeout(() => {
            // Use call.id for audio URL
            initWaveSurfer(call.id, `/audio/${call.id}`, talkgroupModalWavesurfers, null, `tg-waveform-${call.id}`);
        }, 0);
    }

    return listItem;
}

// NEW: Function to show the talkgroup modal
function showTalkgroupModal(talkgroupId, talkgroupName, targetCallId = null) {
    const modal = document.getElementById('talkgroup-modal');
    const titleElement = document.getElementById('talkgroup-modal-title');
    const listElement = document.getElementById('talkgroup-list');

    if (!modal || !titleElement || !listElement) {
        console.error('Talkgroup modal elements not found!');
        return;
    }

    // Set title
    titleElement.textContent = talkgroupName || 'Talkgroup History';

    // --- Reset state and content ---
    listElement.innerHTML = '<div class="loading-placeholder">Loading history...</div>';
    isTalkgroupModalOpen = true;
    currentOpenTalkgroupId = talkgroupId;
    // Reset pagination state
    currentTalkgroupOffset = 0;
    isLoadingMoreTalkgroupCalls = false;
    hasMoreTalkgroupCalls = true; // Assume there might be more initially
    isSearchingForTargetCall = !!targetCallId; // NEW: Set based on if targetCallId is provided

    // Clear previous wavesurfers immediately before fetching new data
    Object.keys(talkgroupModalWavesurfers).forEach(callId => {
        if (talkgroupModalWavesurfers[callId]) {
            talkgroupModalWavesurfers[callId].destroy();
        }
    });
    for (let key in talkgroupModalWavesurfers) {
        delete talkgroupModalWavesurfers[key];
    }

    // --- Fetch initial page or start target search --- 
    listElement.innerHTML = '<div class="loading-placeholder">Loading history...</div>';

    // Define the recursive fetcher for finding the target
    async function fetchPageAndFindTarget(offset) {
        if (!isTalkgroupModalOpen || !isSearchingForTargetCall) {
            // Modal closed or search aborted/completed
            isLoadingMoreTalkgroupCalls = false;
            return;
        }

        isLoadingMoreTalkgroupCalls = true;
        if (offset === 0) { // Only show "Searching..." on the very first call of this recursive function
            listElement.innerHTML = '<div class="loading-placeholder">Searching for specific call...</div>';
        }
        
        const loadingIndicatorWhileSearching = document.createElement('div');
        if (offset > 0) { // Add a small indicator for subsequent fetches during search
            loadingIndicatorWhileSearching.className = 'loading-placeholder subtle-loader';
            loadingIndicatorWhileSearching.textContent = 'Loading more to find call...';
            listElement.appendChild(loadingIndicatorWhileSearching);
        }

        try {
            const response = await fetch(`/api/talkgroup/${talkgroupId}/calls?limit=${talkgroupPageLimit}&offset=${offset}`);
            const calls = await response.json();

            if (offset === 0 && listElement.querySelector('.loading-placeholder')) {
                listElement.innerHTML = ''; // Clear "Searching..." or initial "Loading..." placeholder
            }
            if (loadingIndicatorWhileSearching.parentNode) {
                loadingIndicatorWhileSearching.remove();
            }

            if (calls && calls.length > 0) {
                calls.forEach(call => {
                    const listItem = createTalkgroupListItem(call);
                    listElement.appendChild(listItem);
                });
                currentTalkgroupOffset += calls.length;
                hasMoreTalkgroupCalls = calls.length === talkgroupPageLimit;

                const targetElement = listElement.querySelector(`.talkgroup-list-item[data-call-id="${targetCallId}"]`);
                if (targetElement) {
                    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    targetElement.classList.add('scrolled-to-highlight');
                    setTimeout(() => targetElement.classList.remove('scrolled-to-highlight'), 2500);
                    console.log(`[TalkgroupModal] Target call ID ${targetCallId} found and scrolled to.`);
                    isSearchingForTargetCall = false; // Target found, stop special search mode
                    isLoadingMoreTalkgroupCalls = false;
                    return; // Exit recursive search
                }
            }

            if (hasMoreTalkgroupCalls && isSearchingForTargetCall) {
                // Target not found yet, and more calls exist, and we are still in search mode
                fetchPageAndFindTarget(currentTalkgroupOffset); // Recursively fetch next page
            } else if (!hasMoreTalkgroupCalls && isSearchingForTargetCall) {
                // No more calls, and target not found
                console.log(`[TalkgroupModal] Target call ID ${targetCallId} not found in the entire history.`);
                // Optionally, add a message to the listElement
                const notFoundMsg = document.createElement('div');
                notFoundMsg.className = 'loading-placeholder';
                notFoundMsg.textContent = 'Target call not found in history.';
                listElement.appendChild(notFoundMsg);
                isSearchingForTargetCall = false;
                isLoadingMoreTalkgroupCalls = false;
            } else {
                 // This case means: either target was found (handled above), or no target search was active.
                 // Or, no more calls and search was not active.
                 isLoadingMoreTalkgroupCalls = false;
            }

        } catch (error) {
            console.error('Error fetching talkgroup page during target search:', error);
            if (loadingIndicatorWhileSearching.parentNode) loadingIndicatorWhileSearching.remove();
            const errorMsg = document.createElement('div');
            errorMsg.className = 'loading-placeholder error';
            errorMsg.textContent = 'Error searching for call.';
            if(listElement.innerHTML.includes('Searching for specific call')) listElement.innerHTML = ''; // Clear search message
            listElement.appendChild(errorMsg);
            isSearchingForTargetCall = false;
            isLoadingMoreTalkgroupCalls = false;
            hasMoreTalkgroupCalls = false; // Stop trying on error
        }
    }

    if (targetCallId) {
        fetchPageAndFindTarget(0); // Start the search for the target call
    } else {
        // No targetCallId, just load the first page normally
        isLoadingMoreTalkgroupCalls = true;
        fetch(`/api/talkgroup/${talkgroupId}/calls?limit=${talkgroupPageLimit}&offset=0`)
            .then(response => response.json())
            .then(calls => {
                listElement.innerHTML = ''; // Clear loading placeholder
                if (calls && calls.length > 0) {
                    calls.forEach(call => {
                        const listItem = createTalkgroupListItem(call);
                        listElement.appendChild(listItem);
                    });
                    currentTalkgroupOffset = calls.length;
                    hasMoreTalkgroupCalls = calls.length === talkgroupPageLimit;
                } else {
                    listElement.innerHTML = '<div class="loading-placeholder">No calls found for this talkgroup.</div>';
                    hasMoreTalkgroupCalls = false;
                }
            })
            .catch(error => {
                console.error('Error fetching initial talkgroup history:', error);
                listElement.innerHTML = '<div class="loading-placeholder error">Error loading call history.</div>';
                hasMoreTalkgroupCalls = false;
            })
            .finally(() => {
                isLoadingMoreTalkgroupCalls = false;
            });
    }

    // --- Add Scroll Listener --- 
    // Remove previous listener first (safety check)
    listElement.removeEventListener('scroll', handleTalkgroupScroll);
    listElement.addEventListener('scroll', handleTalkgroupScroll);

    // Display the modal
    modal.style.display = 'block';

    // --- Auto-mute main new calls --- 
    const mainMuteCheckbox = document.getElementById('mute-new-calls');
    if (mainMuteCheckbox) {
        originalMuteStateBeforeModal = mainMuteCheckbox.checked; // Store original state
        if (!originalMuteStateBeforeModal) { // Only check it if it wasn't already checked
            mainMuteCheckbox.checked = true;
            mainMuteCheckbox.dispatchEvent(new Event('change')); // Trigger state update
            console.log("Temporarily muted main new call sounds.");
        }
    }
    // --- End auto-mute ---

    // Set initial state of autoplay toggle and add listener
    const autoplayToggle = document.getElementById('talkgroup-autoplay-toggle');
    const autoplayLabel = document.getElementById('talkgroup-autoplay-label'); // Get the label
    const autoplayLabelTextSpan = autoplayLabel?.querySelector('span'); // Get the inner span

    if (autoplayToggle && autoplayLabel && autoplayLabelTextSpan) { // Check all exist
        autoplayToggle.checked = talkgroupModalAutoplay;
        // Set initial class based on default state
        if (talkgroupModalAutoplay) {
            // autoplayLabel.classList.add('live-indicator'); // Old way
            autoplayLabelTextSpan.classList.add('loading-ellipsis'); // Add to span
        } else {
            // autoplayLabel.classList.remove('live-indicator'); // Old way
            autoplayLabelTextSpan.classList.remove('loading-ellipsis'); // Remove from span
        }
        // Remove previous listener before adding new one
        autoplayToggle.removeEventListener('change', handleTalkgroupAutoplayChange);
        autoplayToggle.addEventListener('change', handleTalkgroupAutoplayChange);
    }

    // Start polling for new calls for this talkgroup
    startTalkgroupPolling(talkgroupId);
}

// NEW: Handler for the autoplay toggle change
function handleTalkgroupAutoplayChange(event) {
    talkgroupModalAutoplay = event.target.checked;
    console.log(`Talkgroup modal autoplay set to: ${talkgroupModalAutoplay}`);

    const autoplayLabel = document.getElementById('talkgroup-autoplay-label'); // Get label
    const autoplayLabelTextSpan = autoplayLabel?.querySelector('span'); // Get inner span

    // if (autoplayLabel) { // Old check
    if (autoplayLabelTextSpan) { // Check if span exists
        if (talkgroupModalAutoplay) {
            // autoplayLabel.classList.add('live-indicator'); // Old way
            autoplayLabelTextSpan.classList.add('loading-ellipsis'); // Add class to span
        } else {
            // autoplayLabel.classList.remove('live-indicator'); // Old way
            autoplayLabelTextSpan.classList.remove('loading-ellipsis'); // Remove class from span
        }
    }
}

// NEW: Function to start polling for new calls in the modal
function startTalkgroupPolling(talkgroupId) {
    // Clear any existing interval first
    if (talkgroupPollingInterval) {
        clearInterval(talkgroupPollingInterval);
    }

    // console.log(`Starting polling for talkgroup ${talkgroupId}...`); // Reduced logging

    talkgroupPollingInterval = setInterval(() => {
        pollForNewTalkgroupCalls(talkgroupId);
    }, 5000); // Poll every 5 seconds (reverted from 3)
}

// NEW: Function that actually performs the poll
function pollForNewTalkgroupCalls(talkgroupId) {
    if (!isTalkgroupModalOpen || currentOpenTalkgroupId !== talkgroupId) {
        // Modal closed or changed talkgroup, stop polling (should be handled by close, but safety check)
        if (talkgroupPollingInterval) clearInterval(talkgroupPollingInterval);
        talkgroupPollingInterval = null;
        return;
    }

    // Use the timestamp of the newest item currently in the modal list
    const listElement = document.getElementById('talkgroup-list');
    const firstItem = listElement?.querySelector('.talkgroup-list-item');
    const newestCallIdInList = firstItem ? parseInt(firstItem.dataset.callId, 10) : 0;

    // Fetch calls newer than the newest one we already have displayed
    // Note: Using ID assumes IDs are sequential and increasing with time
    fetch(`/api/talkgroup/${talkgroupId}/calls?sinceId=${newestCallIdInList}`)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(newCalls => {
            if (newCalls && newCalls.length > 0) {
                // console.log(`Poll received ${newCalls.length} new call(s) for talkgroup ${talkgroupId}`); // Reduced logging
                const placeholder = listElement.querySelector('.loading-placeholder');
                if (placeholder) placeholder.remove(); // Remove placeholder if present

                // Sort potentially multiple new calls by timestamp (newest first for prepending)
                newCalls.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

                newCalls.forEach(call => {
                     // Double-check we haven't already added this ID (e.g., from rapid polling)
                     if (!listElement.querySelector(`.talkgroup-list-item[data-call-id="${call.id}"]`)) {
                        const newItem = createTalkgroupListItem(call);
                        newItem.classList.add('new-item-highlight');
                        listElement.prepend(newItem);

                        // Initialize WaveSurfer for the new item and provide the autoplay callback
                        if (call.id) { // Check if ID exists (audio should exist)
                           setTimeout(() => { // Keep setTimeout(0) to ensure newItem is in DOM
                               initWaveSurfer(
                                   call.id, 
                                   `/audio/${call.id}`, 
                                   talkgroupModalWavesurfers, 
                                   () => { // Define the onReadyCallback inline here
                                       if (talkgroupModalAutoplay && isTalkgroupModalOpen && currentOpenTalkgroupId === talkgroupId) {
                                            console.log(`[Autoplay] WaveSurfer ready for ${call.id}, attempting autoplay.`);
                                            playWaveSurferAudio(call.id, talkgroupModalWavesurfers);
                                       }
                                   }, 
                                   `tg-waveform-${call.id}`
                               );
                           }, 0);
                        }
                     }
                });

                // Optional: Prune old items if list gets too long
                const maxItems = 100;
                while (listElement.children.length > maxItems) {
                    const oldestItem = listElement.lastElementChild;
                    const oldCallId = oldestItem.dataset.callId;
                    if (talkgroupModalWavesurfers[oldCallId]) {
                        talkgroupModalWavesurfers[oldCallId].destroy();
                        delete talkgroupModalWavesurfers[oldCallId];
                    }
                    listElement.removeChild(oldestItem);
                }
            }
        })
        .catch(error => {
            console.warn(`Polling error for talkgroup ${talkgroupId}:`, error);
            // Optionally stop polling on repeated errors?
        });
}



function showNotification(message, type = 'success') {
  const notification = document.createElement('div');
  notification.className = 'notification';
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background-color: ${type === 'success' ? 'var(--hover-color)' : '#330000'};
    color: ${type === 'success' ? 'var(--text-color)' : '#ff0000'};
    border: 1px solid ${type === 'success' ? 'var(--border-color)' : '#ff0000'};
    padding: 15px 20px;
    border-radius: 4px;
    font-family: 'Share Tech Mono', monospace;
    z-index: 2000;
    box-shadow: 0 0 10px ${type === 'success' ? 'rgba(0, 255, 0, 0.3)' : 'rgba(255, 0, 0, 0.3)'};
    animation: notificationSlideIn 0.3s ease-out;
  `;
  
  notification.innerHTML = `
    <div class="flex items-center">
      <span style="margin-right: 8px;">${type === 'success' ? '✓' : '✕'}</span>
      <span>${message}</span>
    </div>
  `;
  
  document.body.appendChild(notification);
  
  // Remove notification after 3 seconds with fade out animation
  setTimeout(() => {
    notification.style.opacity = '0';
    notification.style.transform = 'translateX(100%)';
    notification.style.transition = 'all 0.3s ease-out';
    
    setTimeout(() => {
      notification.remove();
    }, 300);
  }, 3000);
}

function setupUserManagement() {
    const userMenuBtn = document.getElementById('user-menu-btn');
    const dropdownContent = document.getElementById('user-menu-content');
    const addUserBtn = document.getElementById('add-user-btn');
    const viewUsersBtn = document.getElementById('view-users-btn');
    
    // Toggle dropdown
    if (userMenuBtn) {
        userMenuBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            dropdownContent.classList.toggle('show');
        });
    }
    
    // Close dropdown when clicking outside
    window.addEventListener('click', function(e) {
        if (!e.target.matches('#user-menu-btn')) {
            if (dropdownContent && dropdownContent.classList.contains('show')) {
                dropdownContent.classList.remove('show');
            }
        }
    });
    
    // Add User button click
    if (addUserBtn) {
        addUserBtn.addEventListener('click', function(e) {
            e.preventDefault();
            showAddUserModal();
        });
    }
    
    // View Users button click
    if (viewUsersBtn) {
        viewUsersBtn.addEventListener('click', function(e) {
            e.preventDefault();
            showViewUsersModal();
        });
    }
    
    // Call Purge button click
    const callPurgeBtn = document.getElementById('call-purge-btn');
    if (callPurgeBtn) {
        callPurgeBtn.addEventListener('click', function(e) {
            e.preventDefault();
            showCallPurgeModal();
            dropdownContent.classList.remove('show');
        });
    }
    
    // Setup modal forms
    setupAddUserForm();
    setupModalCancelButtons();
    setupCallPurgeModal();
}

function showAddUserModal() {
    const modal = document.getElementById('add-user-modal');
    if (modal) {
        modal.style.display = 'block';
    }
}

function showViewUsersModal() {
    const modal = document.getElementById('view-users-modal');
    if (modal) {
        loadUsersList();
        modal.style.display = 'block';
    }
}

function setupAddUserForm() {
    const form = document.getElementById('add-user-form');
    if (form) {
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            
            const username = document.getElementById('new-username').value;
            const password = document.getElementById('new-password').value;
            
            fetch('/api/users', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password })
            })
            .then(response => response.json())
            .then(data => {
                if (data.error) {
                    showNotification(data.error, 'error');
                } else {
                    showNotification('User added successfully', 'success');
                    document.getElementById('add-user-modal').style.display = 'none';
                    form.reset();
                }
            })
            .catch(error => {
                showNotification('Error adding user', 'error');
                console.error('Error:', error);
            });
        });
    }
}

function loadUsersList() {
    const usersList = document.getElementById('users-list');
    if (usersList) {
        usersList.innerHTML = 'Loading users...';
        
        fetch('/api/users')
            .then(response => response.json())
            .then(users => {
                usersList.innerHTML = users.map(user => `
                    <div class="user-item">
                        <div class="user-info">
                            <strong>${user.username}</strong><br>
                            <small>Created: ${new Date(user.created_at).toLocaleString()}</small>
                        </div>
                        <div class="user-actions">
                            <button class="delete-user-btn" data-user-id="${user.id}">Delete</button>
                        </div>
                    </div>
                `).join('');
                
                // Add event listeners for delete buttons
                document.querySelectorAll('.delete-user-btn').forEach(button => {
                    button.addEventListener('click', function() {
                        const userId = this.getAttribute('data-user-id');
                        deleteUser(userId);
                    });
                });
            })
            .catch(error => {
                usersList.innerHTML = 'Error loading users.';
                console.error('Error:', error);
            });
    }
}

function deleteUser(userId) {
    if (confirm('Are you sure you want to delete this user?')) {
        fetch(`/api/users/${userId}`, {
            method: 'DELETE'
        })
        .then(response => response.json())
        .then(data => {
            if (data.error) {
                showNotification(data.error, 'error');
            } else {
                showNotification('User deleted successfully', 'success');
                loadUsersList(); // Reload the users list
            }
        })
        .catch(error => {
            showNotification('Error deleting user', 'error');
            console.error('Error:', error);
        });
    }
}

function setupModalCancelButtons() {
    document.querySelectorAll('.cancel-btn').forEach(button => {
        button.addEventListener('click', function() {
            this.closest('.modal').style.display = 'none';
        });
    });
}

function setupSessionManagement() {
    // Get the existing "Manage Sessions" button by its ID
    const manageSessionsBtn = document.getElementById('manage-sessions-btn');

    if (manageSessionsBtn) {
        // Add an event listener to the button
        manageSessionsBtn.addEventListener('click', function(e) {
            e.preventDefault();
            showSessionsModal();
        });
    } else {
        console.error('Manage Sessions button not found');
    }
}

function showSessionsModal() {
    const modal = document.getElementById('sessions-modal');
    if (modal) {
        loadUsersForDropdown(); // Load users into the dropdown
        loadSessionsList(); // Load sessions for the default or selected user
        modal.style.display = 'block';
    }
}

function loadUsersForDropdown() {
    const userDropdown = document.getElementById('user-dropdown');
    if (!userDropdown) return;
    
    fetch('/api/users')
        .then(response => response.json())
        .then(users => {
            // Clear existing options
            userDropdown.innerHTML = '';
            // Add an option to select all users (optional, for admins)
            const allUsersOption = document.createElement('option');
            allUsersOption.value = 'all';
            allUsersOption.textContent = 'All Users';
            userDropdown.appendChild(allUsersOption);

            // Populate dropdown with users
            users.forEach(user => {
                const option = document.createElement('option');
                option.value = user.id;
                option.textContent = user.username;
                userDropdown.appendChild(option);
            });

            // Add event listener for dropdown change
            userDropdown.addEventListener('change', () => {
                loadSessionsList(); // Reload sessions when user selection changes
            });
        })
        .catch(error => {
            console.error('Error loading users for dropdown:', error);
        });
}

function loadSessionsList() {
    const sessionsList = document.getElementById('sessions-list');
    if (!sessionsList) return;
    
    const userDropdown = document.getElementById('user-dropdown');
    const selectedUserId = userDropdown ? userDropdown.value : 'all';

    sessionsList.innerHTML = '<div class="loading">Loading sessions...</div>';

    // Build the URL with the selected user ID
    let url = '/api/sessions';
    if (selectedUserId && selectedUserId !== 'all') {
        url += `?userId=${selectedUserId}`;
    }

    fetch(url)
        .then(response => response.json())
        .then(sessions => {
            sessionsList.innerHTML = sessions.length ? sessions.map((session) => `
                <div class="session-item ${session.token === currentSessionToken ? 'current-session' : ''}">
                    <div class="session-info">
                        <div class="session-details">
                            <strong>${session.username}</strong>
                            ${session.token === currentSessionToken ? ' (Current Session)' : ''}<br>
                            <small>Created: ${new Date(session.created_at).toLocaleString()}</small><br>
                            <small>Expires: ${new Date(session.expires_at).toLocaleString()}</small>
                            <div class="device-info">
                                <small>${session.user_agent || 'Unknown Device'}</small><br>
                                <small>IP: ${session.ip_address || 'Unknown'}</small>
                            </div>
                        </div>
                        <div class="session-actions">
                            ${session.token !== currentSessionToken ? 
                                `<button class="terminate-session-btn" onclick="terminateSession('${session.token}')">
                                    Terminate
                                </button>` : 
                                ''
                            }
                        </div>
                    </div>
                </div>
            `).join('') : '<div class="no-sessions">No active sessions found</div>';
        })
        .catch(error => {
            console.error('Error loading sessions:', error);
            sessionsList.innerHTML = '<div class="error">Error loading sessions</div>';
        });
}

function terminateSession(token) {
    if (confirm('Are you sure you want to terminate this session?')) {
        fetch(`/api/sessions/${token}`, {
            method: 'DELETE'
        })
        .then(response => response.json())
        .then(data => {
            showNotification('Session terminated successfully', 'success');
            loadSessionsList();
        })
        .catch(error => {
            console.error('Error terminating session:', error);
            showNotification('Error terminating session', 'error');
        });
    }
}
// Function to check if current user is admin
async function checkAdminStatus() {
  try {
    const response = await fetch('/api/auth/is-admin');
    const data = await response.json();
    const wasAdmin = isAdminUser;
    const wasAuthEnabled = authEnabled;
    
    isAdminUser = data.isAdmin;
    authEnabled = data.authEnabled;
    
    console.log(`[Auth] Admin status: ${isAdminUser}, Auth enabled: ${authEnabled}`);
    
    // If admin status or auth status changed, update existing markers
    if (wasAdmin !== isAdminUser || wasAuthEnabled !== authEnabled) {
      updateExistingMarkersForAdminStatus();
    }
  } catch (error) {
    console.error('[Auth] Error checking admin status:', error);
    isAdminUser = false;
    authEnabled = false;
  }
}

// Function to update existing markers when admin status changes
function updateExistingMarkersForAdminStatus() {
  console.log(`[Auth] Updating existing markers for admin status: ${isAdminUser}`);
  
  // Update all existing markers
  Object.keys(markers).forEach(callId => {
    const marker = markers[callId];
    if (marker && marker.isPopupOpen()) {
      // If popup is open, close it to force refresh
      marker.closePopup();
    }
  });
}

// Function to setup the sidebar toggle button
function setupSidebarToggle() {
  const toggleBtn = document.getElementById('sidebar-toggle-btn');
  const sidebar = document.getElementById('category-sidebar');

  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener('click', () => {
      sidebar.classList.toggle('sidebar-hidden');
      // Optional: Change button text/icon when sidebar is hidden/shown
      if (sidebar.classList.contains('sidebar-hidden')) {
        toggleBtn.textContent = '☰ Show Categories';
        toggleBtn.setAttribute('aria-expanded', 'false');
      } else {
        toggleBtn.textContent = '✕ Hide Categories';
         toggleBtn.setAttribute('aria-expanded', 'true');
      }
    });

    // Ensure sidebar is hidden by default on mobile if the screen is small on load
    if (isMobile() && !sidebar.classList.contains('sidebar-hidden')) {
         sidebar.classList.add('sidebar-hidden');
         toggleBtn.textContent = '☰ Show Categories';
         toggleBtn.setAttribute('aria-expanded', 'false');
    } else if (!isMobile() && sidebar.classList.contains('sidebar-hidden')) {
         // Ensure sidebar is shown on desktop if window resizes large
         sidebar.classList.remove('sidebar-hidden');
         toggleBtn.textContent = '✕ Hide Categories'; // Or revert to default if needed
         toggleBtn.setAttribute('aria-expanded', 'true');
    }

  } else {
    console.error('Sidebar toggle button or sidebar element not found.');
  }
}
// User and Session Management functions remain the same

// REMOVED DOMContentLoaded listener - initializeApp is called directly now
// document.addEventListener('DOMContentLoaded', initializeApp);

document.addEventListener('DOMContentLoaded', initializeApp); // Re-add DOMContentLoaded listener

async function initializeApp() {
    console.log("[App] Initializing..."); // Add log
    // Wait for remote config (map center/zoom + geocoding provider) so the map
    // initializes at the configured location instead of the hardcoded default.
    try { if (window.configReady) await window.configReady; } catch (e) { console.warn('configReady failed:', e); }
    // Initialize configuration variables from the config
    timeRangeHours = appConfig.time.defaultTimeRangeHours;
    heatmapIntensity = appConfig.heatmap.defaultIntensity;
    
    // Initialize custom icons from config
    Object.assign(customIcons, createIconsFromConfig());
    
    // First ensure audio context is created
    initAudioContext();
    
    // Now we can safely set up the volume control
    setupVolumeControl();
    
    attemptAutoplay();
    initMap();
    setupCallsAndUpdates();
    setupSearch();
    setupCallControls();
    setupTimeFilter();
    setupHeatmapControls();
    setupLiveFeed();
    setupUserLocationButton(); // ADDED: Setup for the new location button
    loadCalls(timeRangeHours);
    setupUserManagement();
    setupSidebarToggle();

    // Initialize the category sidebar content dynamically
    updateCategoryCounts();
    
    // Start timestamp updates
    startTimestampUpdates();
    
    // Check admin status
    checkAdminStatus();
    
    // Set up periodic admin status check
    setInterval(checkAdminStatus, 30000); // Check every 30 seconds
    
    fetch('/api/sessions/current')
        .then(response => response.json())
        .then(data => {
            currentSessionToken = data.session?.token;
            setupSessionManagement();
            // Re-check admin status after session setup
            checkAdminStatus();
        })
        .catch(error => {
            console.error('Error getting current session:', error);
            setupSessionManagement();
        });
    // (Removed a duplicate loadCalls() that ran a second redundant fetch on load.)
}
// Function to load and display summary
function loadSummary() {
  fetch('/summary.json')
    .then(response => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .then(data => {
      const ticker = document.querySelector('.ticker');
      if (!ticker) {
          console.error('Ticker element not found.');
          return;
      }
      const tickerWrap = document.querySelector('.ticker-wrap');
       if (!tickerWrap) {
          console.error('Ticker wrap element not found.');
          return;
      }

      // --- NEW TICKER CONTENT HANDLING ---
      // Create content with main summary and highlights
      let baseContent = `${data.summary} | `;

      // Add highlights if available
      if (data.highlights && data.highlights.length > 0) {
        data.highlights.forEach(highlight => {
          // IMPORTANT: Use the class "summary-highlight" here
          baseContent += `<span class="summary-highlight">${highlight.talk_group}</span>: ${highlight.description} (${highlight.time}) | `;
        });
      }

      // Add update time
      baseContent += `Updated: ${new Date(data.updated).toLocaleTimeString()} | `;

      // Create the main ticker item
      const tickerItem = document.createElement('div');
      tickerItem.className = 'ticker-item';
      tickerItem.innerHTML = baseContent;

      // Create a duplicate ticker item for seamless looping (CSS will handle positioning)
      const tickerItemDuplicate = document.createElement('div');
      tickerItemDuplicate.className = 'ticker-item';
      tickerItemDuplicate.innerHTML = baseContent;
      tickerItemDuplicate.setAttribute('aria-hidden', 'true'); // Hide duplicate from screen readers

       // Clear previous ticker content
      ticker.innerHTML = '';

      // Append the items
      ticker.appendChild(tickerItem);
      ticker.appendChild(tickerItemDuplicate);

      // Reset animation (force restart if content changes)
      // This ensures the animation restarts correctly if the content width changes significantly
      ticker.style.animation = 'none';
      void ticker.offsetWidth; // Trigger reflow to apply the 'none' state
      ticker.style.animation = ''; // Re-apply animation from CSS defined rules

      // OPTIONAL: Dynamically adjust speed based on content width
      // Uncomment the following lines if you want speed to adjust
      /*
      const contentWidth = tickerItem.offsetWidth; // Get width of one copy
      if (contentWidth > 0 && tickerWrap.offsetWidth > 0) {
          const pixelsPerSecond = 75; // Adjust this value to control speed (higher = faster)
          const duration = contentWidth / pixelsPerSecond;
          // Use the animation name defined in CSS ('ticker-scroll')
          ticker.style.animation = `ticker-scroll ${Math.max(20, duration)}s linear infinite`; // Ensure a minimum duration
          console.log(`Ticker animation duration set to: ${ticker.style.animationDuration}`);
      } else {
           // Fallback if widths aren't available yet - use CSS default
           console.log('Could not calculate dynamic ticker duration, using CSS default.');
      }
      */

      console.log(`Ticker content updated.`);
      // --- END NEW TICKER CONTENT HANDLING ---

    })
    .catch(error => {
      console.error('Error loading or processing summary:', error);
      const ticker = document.querySelector('.ticker');
      if (ticker) {
        // Display error message within the ticker for visibility
        ticker.innerHTML = '<div class="ticker-item" style="color: #ff3333;">Error loading summary information</div>';
        // Stop any running animation
        ticker.style.animation = 'none';
      }
    });
}
// Load summary immediately
loadSummary();

// Set up summary refresh interval (every 3 minutes)
setInterval(loadSummary, 180000); // Changed from 120000 (2 mins) to 180000 (3 mins)
// Update volume slider style
/* // REMOVE THIS BLOCK
document.addEventListener('input', function(e) {
    if (e.target.classList.contains('volume')) {
        const value = e.target.value;
        e.target.style.setProperty('--value', `${value * 100}%`);
    }
});
*/

// NEW: Function to setup the global volume control listener
function setupGlobalVolumeControl() {
    // Get the volume slider element - MUST BE DIFFERENT from heatmap slider
    const volumeSlider = document.getElementById('global-volume');
    if (!volumeSlider) {
        console.error("Global volume slider not found!");
        return;
    }
    
    if (volumeSlider.id === 'heatmap-intensity') {
        console.error("CRITICAL ERROR: Volume slider has wrong ID! Should be 'global-volume', not 'heatmap-intensity'");
        return;
    }
    
    // First remove all existing event listeners
    const newSlider = volumeSlider.cloneNode(true);
    if (volumeSlider.parentNode) {
        volumeSlider.parentNode.replaceChild(newSlider, volumeSlider);
    } else {
        console.error("Slider has no parent node!");
        return;
    }
    
    // For clarity, add a custom attribute
    newSlider.setAttribute('data-slider-type', 'volume');
    
    // Set initial slider value
    newSlider.value = globalVolumeLevel;
    updateSliderFill(newSlider);
    
    // Single event handler function for all volume change events
    const handleVolumeChange = function(e) {
        // Validate this is the correct slider
        if (this.id !== 'global-volume') {
            console.error(`Wrong slider triggered volume change! ID: ${this.id}`);
            return;
        }
        
        const value = parseFloat(this.value);
        
        // Apply the volume
        setGlobalVolume(value);
        
        // Prevent event from bubbling up to avoid conflict with other sliders
        e.stopPropagation();
    };
    
    // Use multiple events for complete browser compatibility
    newSlider.addEventListener('input', handleVolumeChange);
    newSlider.addEventListener('change', handleVolumeChange);
    
    // Also add mouseup and touchend events to catch all possible interactions
    newSlider.addEventListener('mouseup', handleVolumeChange);
    newSlider.addEventListener('touchend', handleVolumeChange);
    
    // Initialize by applying the current volume globally
    setGlobalVolume(globalVolumeLevel);
}

// Global function to set all audio volumes
function setGlobalVolume(volume) {
    // Clamp volume to 0-1 range
    volume = Math.max(0, Math.min(1, parseFloat(volume)));
    
    // Update global variable
    globalVolumeLevel = volume;
    
    // Update all gain nodes if they exist
    if (window.audioContext && window.globalGainNode) {
        try {
            // Immediately set the value property
            window.globalGainNode.gain.value = volume;
            
            // Also use the time-based method for smooth transitions
            window.globalGainNode.gain.setValueAtTime(volume, window.audioContext.currentTime);
        } catch (err) {
            console.error("Error setting gain node volume:", err);
        }
    }
    
    // Update all wavesurfer instances in main map
    Object.keys(wavesurfers).forEach(callId => {
        if (wavesurfers[callId]) {
            try {
                wavesurfers[callId].setVolume(volume);
            } catch (err) {
                console.warn(`Error setting volume for wavesurfer ${callId}:`, err);
            }
        }
    });
    
    // Update all wavesurfer instances in talkgroup modal
    Object.keys(talkgroupModalWavesurfers).forEach(callId => {
        if (talkgroupModalWavesurfers[callId]) {
            try {
                talkgroupModalWavesurfers[callId].setVolume(volume);
            } catch (err) {
                console.warn(`Error setting volume for modal wavesurfer ${callId}:`, err);
            }
        }
    });
    
    // Update any volume sliders that may exist
    const volumeSlider = document.getElementById('global-volume');
    if (volumeSlider && volumeSlider.value !== volume.toString()) {
        volumeSlider.value = volume;
        updateSliderFill(volumeSlider);
    }
}

// NEW Handler for Live Feed Updates
function handleLiveFeedUpdate(call) {
    // OPTIMIZATION: Skip if nothing is selected/enabled
    if (liveFeedSelectedTalkgroups.size === 0 && !isLiveFeedAudioEnabled) {
        // console.log("[LiveFeed] No talkgroups selected and audio disabled. Skipping update.");
        return; 
    }
    
    // console.log("[LiveFeed] handleLiveFeedUpdate triggered for call ID:", call.id);
    const incomingTgId = parseInt(call.talk_group_id, 10); 

    // Check if the talkgroup is selected
    if (liveFeedSelectedTalkgroups.has(incomingTgId)) { 
        // console.log(`[LiveFeed] Match found for TG ID ${incomingTgId}! Calling displayLiveFeedItem.`);
        displayLiveFeedItem(call); // Display the item (handles audio internally)
    } else {
        // console.log(`[LiveFeed] Call TG ID ${incomingTgId} ignored. Selected: ${liveFeedSelectedTalkgroups.has(incomingTgId)}`);
    }
}

// NEW: Live Feed Setup and Helper Functions

function setupLiveFeed() {
    console.log("[LiveFeed] Setting up Live Feed UI and listeners...");

    // Check each element individually
    liveFeedSetupBtn = document.getElementById('live-feed-setup-btn');
    if (!liveFeedSetupBtn) console.error("[LiveFeed] Failed to find #live-feed-setup-btn");

    liveFeedModal = document.getElementById('live-feed-modal');
    if (!liveFeedModal) console.error("[LiveFeed] Failed to find #live-feed-modal");

    liveFeedSearchInput = document.getElementById('live-feed-search');
    if (!liveFeedSearchInput) console.error("[LiveFeed] Failed to find #live-feed-search");

    liveFeedTalkgroupListContainer = document.getElementById('live-feed-talkgroup-list');
    if (!liveFeedTalkgroupListContainer) console.error("[LiveFeed] Failed to find #live-feed-talkgroup-list");

    liveFeedDisplayContainer = document.getElementById('live-feed-display');
    if (!liveFeedDisplayContainer) console.error("[LiveFeed] Failed to find #live-feed-display");

    // Check if ALL required elements were found
    if (!liveFeedSetupBtn || !liveFeedModal || !liveFeedSearchInput || !liveFeedTalkgroupListContainer || !liveFeedDisplayContainer) {
        console.error("[LiveFeed] Initialization failed due to missing elements.");
        return; // Stop setup if elements are missing
    }

    console.log("[LiveFeed] All required elements found.");

    // --- REMOVING DEBUG LOG ---
    // console.log("[LiveFeed] Value of liveFeedSetupBtn before addEventListener:", liveFeedSetupBtn);
    // --- END DEBUG LOG ---

    // Listener to open the modal
    try { // Add try-catch for more detailed error
        liveFeedSetupBtn.addEventListener('click', openLiveFeedModal);
    } catch (error) {
        console.error("[LiveFeed] Error adding event listener to liveFeedSetupBtn:", error);
        console.error("[LiveFeed] liveFeedSetupBtn value at time of error:", liveFeedSetupBtn);
    }

    // Listeners within the modal
    // --- REMOVING DEBUG LOG ---
    // console.log("[LiveFeed] Value of liveFeedSearchInput before addEventListener:", liveFeedSearchInput);
    // --- END DEBUG LOG ---
    try { // Add try-catch for more detailed error
        liveFeedSearchInput.addEventListener('input', handleLiveFeedSearch);
    } catch (error) {
        console.error("[LiveFeed] Error adding event listener to liveFeedSearchInput:", error);
        console.error("[LiveFeed] liveFeedSearchInput value at time of error:", liveFeedSearchInput);
    }


    // Initial state setup
    // REMOVED: liveFeedEnableCheckbox.checked = isLiveFeedEnabled;
    updateLiveFeedDisplayVisibility(); // Use helper function for initial state

    // Fetch all talkgroups for the modal (unchanged)
    fetch('/api/talkgroups')
        .then(response => response.json())
        .then(talkgroups => {
            allLiveFeedTalkgroups = talkgroups; // Cache the list
            console.log(`[LiveFeed] Fetched ${allLiveFeedTalkgroups.length} talkgroups.`);
        })
        .catch(error => {
            console.error('[LiveFeed] Error fetching talkgroups:', error);
            liveFeedTalkgroupListContainer.innerHTML = '<div class="loading-placeholder error">Error loading talkgroups.</div>';
        });
}

function openLiveFeedModal() {
    if (!liveFeedModal || !allLiveFeedTalkgroups) return;
    console.log("[LiveFeed] Opening setup modal.");
    liveFeedModal.style.display = 'block';
    populateLiveFeedTalkgroups(); // Populate with current selections
    // Ensure display state is correct when opening modal
    liveFeedDisplayContainer.style.display = liveFeedSelectedTalkgroups.size > 0 ? 'flex' : 'none'; 
}

// Placeholder for the globally accessible close function (defined in index.html)
function closeLiveFeedModal() { 
    const modal = document.getElementById('live-feed-modal');
    if (modal) {
        modal.style.display = 'none';
    }
    // Ensure display state is correct when closing modal
    if (liveFeedDisplayContainer) { // Add check for safety
       liveFeedDisplayContainer.style.display = liveFeedSelectedTalkgroups.size > 0 ? 'flex' : 'none'; 
    }
}

function populateLiveFeedTalkgroups() {
    if (!liveFeedTalkgroupListContainer) return;

    // Show loading state
    liveFeedTalkgroupListContainer.innerHTML = '<div class="loading-placeholder">Loading talkgroups...</div>';

    // Use requestAnimationFrame to ensure DOM updates happen after processing
    requestAnimationFrame(() => {
        const searchTerm = liveFeedSearchInput.value.toLowerCase();
        
        // Filter talkgroups based on search term
        const filteredTalkgroups = allLiveFeedTalkgroups.filter(tg =>
            tg.name.toLowerCase().includes(searchTerm)
        );

        if (filteredTalkgroups.length === 0) {
            liveFeedTalkgroupListContainer.innerHTML = '<div class="loading-placeholder">No matching talkgroups found.</div>';
            return;
        }

        // Separate selected and unselected talkgroups instead of sorting
        const selectedTalkgroups = [];
        const unselectedTalkgroups = [];

        filteredTalkgroups.forEach(tg => {
            if (liveFeedSelectedTalkgroups.has(tg.id)) {
                selectedTalkgroups.push(tg);
            } else {
                unselectedTalkgroups.push(tg);
            }
        });

        // Sort each group alphabetically
        selectedTalkgroups.sort((a, b) => a.name.localeCompare(b.name));
        unselectedTalkgroups.sort((a, b) => a.name.localeCompare(b.name));

        // Limit display for performance (prioritize selected talkgroups)
        const displaySelected = selectedTalkgroups.slice(0, MAX_TALKGROUPS_DISPLAY);
        const remainingSlots = MAX_TALKGROUPS_DISPLAY - displaySelected.length;
        const displayUnselected = unselectedTalkgroups.slice(0, Math.max(0, remainingSlots));

        // Build HTML with separate sections
        let html = '';
        
        // Selected talkgroups section
        if (displaySelected.length > 0) {
            html += '<div class="live-feed-section-header">Selected Talkgroups</div>';
            html += displaySelected.map(tg => `
                <div class="live-feed-tg-item selected">
                    <input type="checkbox"
                           id="live-feed-tg-${tg.id}"
                           data-tg-id="${tg.id}"
                           checked>
                    <label for="live-feed-tg-${tg.id}">${tg.name}</label>
                </div>
            `).join('');
        }

        // Unselected talkgroups section
        if (displayUnselected.length > 0) {
            if (displaySelected.length > 0) {
                html += '<div class="live-feed-section-header">Available Talkgroups</div>';
            }
            html += displayUnselected.map(tg => `
                <div class="live-feed-tg-item">
                    <input type="checkbox"
                           id="live-feed-tg-${tg.id}"
                           data-tg-id="${tg.id}">
                    <label for="live-feed-tg-${tg.id}">${tg.name}</label>
                </div>
            `).join('');
        }

        // Show message if results were truncated
        const totalFiltered = filteredTalkgroups.length;
        const totalDisplayed = displaySelected.length + displayUnselected.length;
        if (totalFiltered > totalDisplayed) {
            html += `<div class="live-feed-truncated-message">
                Showing ${totalDisplayed} of ${totalFiltered} talkgroups. 
                Use search to narrow results.
            </div>`;
        }

        // Update DOM
        liveFeedTalkgroupListContainer.innerHTML = html;

        // Add event listeners
        liveFeedTalkgroupListContainer.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
            checkbox.addEventListener('change', handleLiveFeedSelectionChange);
        });
    });
}

function handleLiveFeedSearch() {
    // Clear existing debounce timer
    if (liveFeedSearchDebounceTimer) {
        clearTimeout(liveFeedSearchDebounceTimer);
    }
    
    // Show loading state immediately
    if (liveFeedTalkgroupListContainer) {
        liveFeedTalkgroupListContainer.innerHTML = '<div class="loading-placeholder">Searching...</div>';
    }
    
    // Set new debounce timer
    liveFeedSearchDebounceTimer = setTimeout(() => {
        populateLiveFeedTalkgroups();
    }, LIVE_FEED_SEARCH_DEBOUNCE_DELAY);
}

function handleLiveFeedSelectionChange(event) {
    const checkbox = event.target;
    const talkgroupId = parseInt(checkbox.dataset.tgId, 10);

    if (checkbox.checked) {
        liveFeedSelectedTalkgroups.add(talkgroupId);
        console.log(`[LiveFeed] Added TG ID ${talkgroupId} to selection. Current set:`, liveFeedSelectedTalkgroups);
    } else {
        liveFeedSelectedTalkgroups.delete(talkgroupId);
         console.log(`[LiveFeed] Removed TG ID ${talkgroupId} from selection. Current set:`, liveFeedSelectedTalkgroups);
    }
    
    // NEW: Update display based on selection size
    updateLiveFeedDisplayVisibility(); // Call the new visibility function

    // NEW: Update audio state based on selection
    isLiveFeedAudioEnabled = liveFeedSelectedTalkgroups.size > 0;
    console.log(`[LiveFeed] Audio state updated to: ${isLiveFeedAudioEnabled}`);

    /* // OLD Logic - replaced by updateLiveFeedDisplayVisibility()
    if (liveFeedDisplayContainer) { // Add safety check
        liveFeedDisplayContainer.style.display = liveFeedSelectedTalkgroups.size > 0 ? 'flex' : 'none';
        // Optional: Clear display if no TGs are selected
        if (liveFeedSelectedTalkgroups.size === 0) {
            liveFeedDisplayContainer.innerHTML = '';
        }
    }
    */
}

// REMOVED function handleMasterEnableChange(event) { ... }

function handleAudioEnableChange(event) { // (Unchanged)
    isLiveFeedAudioEnabled = event.target.checked;
    console.log(`[LiveFeed] Audio Enabled set to: ${isLiveFeedAudioEnabled}`);
}

// Ensure displayLiveFeedItem is defined before handleLiveFeedUpdate
function displayLiveFeedItem(call) {
    // MODIFIED: Removed check for isLiveFeedEnabled
    if (!liveFeedDisplayContainer) return; 

    const existingItem = liveFeedDisplayContainer.querySelector(`#live-feed-item-${call.id}`);
    if (existingItem) {
        // console.log(`[LiveFeed] Item ${call.id} already displayed. Skipping duplicate.`);
        return; // Avoid adding duplicates if event fires rapidly
    }

    const newItem = document.createElement('div');
    newItem.className = 'live-feed-item';
    newItem.id = `live-feed-item-${call.id}`; // Assign an ID for easy targeting

    // Wrap content in a span for measurement and scrolling
    const contentSpan = document.createElement('span');
    contentSpan.className = 'scroll-content';
    // Initial content based on whether transcription is pending
    const initialTranscription = (call.transcription && call.transcription !== "[Transcription Pending...]") 
                               ? call.transcription 
                               : "[Transcription Pending...]";
    contentSpan.innerHTML = `<strong>${call.talk_group_name || 'Unknown TG'}</strong>: <span class="transcription-text">${initialTranscription}</span>`;
    newItem.appendChild(contentSpan);

    liveFeedDisplayContainer.prepend(newItem);

    // Check for overflow AFTER adding to DOM and applying styles
    requestAnimationFrame(() => {
        const itemWidth = newItem.clientWidth;
        const contentWidth = contentSpan.scrollWidth;
        if (contentWidth > itemWidth) {
            newItem.classList.add('scrolling');
            const scrollSpeed = 50;
            const duration = contentWidth / scrollSpeed;
            contentSpan.style.animationDuration = `${Math.max(5, duration)}s`;
        }
    });

    while (liveFeedDisplayContainer.children.length > MAX_LIVE_FEED_ITEMS) {
        liveFeedDisplayContainer.removeChild(liveFeedDisplayContainer.lastElementChild);
    }

    // Setup removal timer
    const removalTimeoutId = setTimeout(() => {
        newItem.classList.add('fading-out');
        setTimeout(() => {
            if (newItem.parentNode === liveFeedDisplayContainer) {
                liveFeedDisplayContainer.removeChild(newItem);
            }
        }, 1500);
    }, LIVE_FEED_ITEM_DURATION - 1500);

    // Retry logic if transcription is pending
    if (initialTranscription === "[Transcription Pending...]") {
        attemptLiveFeedRetry(call.id, newItem, 0, removalTimeoutId);
    }

    // Live Audio Logic
    if (isLiveFeedAudioEnabled && call.id && call.transcription !== "[Transcription Pending...]") { 
        // Only play audio if transcription is not pending initially
        // console.log(`[LiveFeed] Attempting live audio for TG ${call.talk_group_id}, Call ${call.id}`);
        playLiveAudio(call);
    }
}

function attemptLiveFeedRetry(callId, itemElement, retryCount, removalTimeoutId) {
    if (!itemElement || !itemElement.parentNode) {
        // console.log(`[LiveFeed Retry] Item ${callId} no longer in DOM. Stopping retries.`);
        return; // Item removed, stop retrying
    }
    if (retryCount >= MAX_LIVE_FEED_RETRIES) {
        // console.log(`[LiveFeed Retry] Max retries reached for ${callId}.`);
        return; // Max retries reached
    }

    setTimeout(async () => {
        // Double check item is still in DOM before fetch
        if (!itemElement || !itemElement.parentNode) return;

        try {
            // console.log(`[LiveFeed Retry] Attempt ${retryCount + 1} for call ID ${callId}`);
            const response = await fetch(`/api/call/${callId}/details`);
            if (!response.ok) {
                // console.warn(`[LiveFeed Retry] API error for ${callId}: ${response.status}`);
                // Optionally retry on certain server errors, or just give up
                if (response.status !== 404) { // Don't retry if call truly not found
                    // Recursive call for next attempt
                    attemptLiveFeedRetry(callId, itemElement, retryCount + 1, removalTimeoutId);
                }
                return;
            }
            const callDetails = await response.json();

            // Check again if item is still in DOM after await
            if (!itemElement || !itemElement.parentNode) return;

            if (callDetails && callDetails.transcription && callDetails.transcription !== "[Transcription Pending...]") {
                // console.log(`[LiveFeed Retry] SUCCESS for ${callId}. New transcription: ${callDetails.transcription}`);
                const contentSpan = itemElement.querySelector('.scroll-content');
                const transcriptionSpan = contentSpan ? contentSpan.querySelector('.transcription-text') : null;
                if (transcriptionSpan) {
                    transcriptionSpan.textContent = callDetails.transcription;
                    // Re-evaluate scrolling if content changed
                    requestAnimationFrame(() => {
                        const itemWidth = itemElement.clientWidth;
                        const newContentWidth = contentSpan.scrollWidth;
                        if (newContentWidth > itemWidth && !itemElement.classList.contains('scrolling')) {
                            itemElement.classList.add('scrolling');
                            const scrollSpeed = 50;
                            const duration = newContentWidth / scrollSpeed;
                            contentSpan.style.animationDuration = `${Math.max(5, duration)}s`;
                        } else if (newContentWidth <= itemWidth && itemElement.classList.contains('scrolling')) {
                            itemElement.classList.remove('scrolling');
                            contentSpan.style.animationDuration = '';
                        }
                    });
                    // Play audio now that transcription is available, if it wasn't played before
                    if (isLiveFeedAudioEnabled && callId) { 
                        playLiveAudio(callDetails); // Pass full details in case playLiveAudio needs more than ID
                    }
                }
            } else {
                // Still pending, retry if not maxed out
                // console.log(`[LiveFeed Retry] Still pending for ${callId}. Retrying...`);
                attemptLiveFeedRetry(callId, itemElement, retryCount + 1, removalTimeoutId);
            }
        } catch (error) {
            console.error(`[LiveFeed Retry] Fetch error for ${callId}:`, error);
            // Potentially retry on network errors too
            attemptLiveFeedRetry(callId, itemElement, retryCount + 1, removalTimeoutId);
        }
    }, LIVE_FEED_RETRY_INTERVAL);
}

// playLiveAudio function (use window.audioContext)
function playLiveAudio(call) {
    // --- Ensure AudioContext exists --- 
    if (!window.audioContext) {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            window.audioContext = new AudioContext();
            // Need to ensure GainNode is also ready if context was just created
            initGlobalGainNode(); 
        } catch (e) {
             console.error('Failed to create AudioContext:', e);
             return; // Cannot proceed without context
        }
    }

    // Resume if suspended
    if (window.audioContext.state === 'suspended') { 
        window.audioContext.resume().catch(e => console.warn('AudioContext resume failed:', e));
    }
    
    const audioUrl = `/audio/${call.id}`; // Corrected: Use call.id
    
    fetch(audioUrl)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.arrayBuffer();
        })
        .then(arrayBuffer => {
            if (!arrayBuffer || arrayBuffer.byteLength === 0) { 
                 throw new Error("Received invalid audio data");
            }
            return window.audioContext.decodeAudioData(arrayBuffer); 
        })
        .then(audioBuffer => {
            const source = window.audioContext.createBufferSource(); 
            source.buffer = audioBuffer;
            
            if (window.globalGainNode) {
                const destinationNode = window.globalGainNode;
                // Force gain value to match global setting
                destinationNode.gain.value = globalVolumeLevel;
                
                source.connect(destinationNode);
                source.start(0);
            } else {
                // Fallback to connect directly to destination, but volume won't work
                source.connect(window.audioContext.destination);
                source.start(0);
            }
        })
        .catch(error => {
            console.error(`Error playing live audio for call ID ${call.id}:`, error);
        });
}

// NOTE: Removed empty stub re-definitions of setupGlobalVolumeControl() and
// initAudioContext() that previously appeared here. Because of function
// hoisting, those empty stubs silently overrode the real implementations
// (defined earlier at the top of this file), disabling volume control and the
// audio context. The real implementations are now the only definitions.

// --- END Live Feed Functions ---

// DEBUG: Volume testing functions
function debugVolume(newVolume) {
    if (newVolume !== undefined) {
        setGlobalVolume(newVolume);
        console.log(`%c[VOLUME DEBUG] Set volume to ${newVolume}`, 'color: green; font-weight: bold');
        
        // Also update the slider directly
        const slider = document.getElementById('global-volume');
        if (slider) {
            slider.value = newVolume;
            updateSliderFill(slider);
            console.log(`%c[VOLUME DEBUG] Slider value set to ${slider.value}`, 'color: green;');
        } else {
            console.log(`%c[VOLUME DEBUG] Could not find slider element!`, 'color: red;');
        }
    } else {
        console.log(`%c[VOLUME DEBUG] Current volume level: ${globalVolumeLevel}`, 'color: blue; font-weight: bold');
        console.log(`%c[VOLUME DEBUG] AudioContext:`, 'color: blue');
        console.log(window.audioContext ? window.audioContext : 'Not initialized');
        console.log(`%c[VOLUME DEBUG] GainNode:`, 'color: blue');
        console.log(window.globalGainNode ? window.globalGainNode : 'Not initialized');
        if (window.globalGainNode) {
            console.log(`%c[VOLUME DEBUG] GainNode value: ${window.globalGainNode.gain.value}`, 'color: green');
        }
        
        // Check slider status
        const slider = document.getElementById('global-volume');
        if (slider) {
            console.log(`%c[VOLUME DEBUG] Slider found: id=${slider.id}, value=${slider.value}`, 'color: green;');
            console.log(slider);
            
            // Try to set up the slider again
            console.log(`%c[VOLUME DEBUG] Attempting to fix slider...`, 'color: orange;');
            setupGlobalVolumeControl();
        } else {
            console.log(`%c[VOLUME DEBUG] Slider not found in DOM!`, 'color: red;');
        }
    }
    
    return "Volume debugging complete";
}

// Make debugVolume available globally
window.debugVolume = debugVolume;

// Function to handle authentication state changes (can be called from login/logout)
window.handleAuthStateChange = function() {
    console.log('[Auth] Authentication state changed, checking admin status...');
    checkAdminStatus();
};

// Global function to set all audio volumes
function setGlobalVolume(volume) {
    // Clamp volume to 0-1 range
    volume = Math.max(0, Math.min(1, parseFloat(volume)));
    
    // Update global variable
    globalVolumeLevel = volume;
    // console.log(`[VOLUME] Setting global volume to ${volume}`); // REMOVE THIS LINE

    // Update all gain nodes if they exist
    if (window.audioContext && window.globalGainNode) {
        try {
            // Immediately set the value property
            window.globalGainNode.gain.value = volume;

            // Also use the time-based method for smooth transitions
            window.globalGainNode.gain.setValueAtTime(volume, window.audioContext.currentTime);
            // console.log(`[VOLUME] Applied to gain node: ${window.globalGainNode.gain.value}`); // REMOVE THIS LINE
        } catch (err) {
            console.error("[VOLUME] Error setting gain node volume:", err);
        }
    }
    
    // Update all wavesurfer instances in main map
    Object.keys(wavesurfers).forEach(callId => {
        if (wavesurfers[callId]) {
            try {
                wavesurfers[callId].setVolume(volume);
            } catch (err) {
                console.warn(`[VOLUME] Error setting volume for wavesurfer ${callId}:`, err);
            }
        }
    });
    
    // Update all wavesurfer instances in talkgroup modal
    Object.keys(talkgroupModalWavesurfers).forEach(callId => {
        if (talkgroupModalWavesurfers[callId]) {
            try {
                talkgroupModalWavesurfers[callId].setVolume(volume);
            } catch (err) {
                console.warn(`[VOLUME] Error setting volume for modal wavesurfer ${callId}:`, err);
            }
        }
    });
    
    // Update any volume sliders that may exist
    const volumeSlider = document.getElementById('global-volume');
    if (volumeSlider && volumeSlider.value !== volume.toString()) {
        volumeSlider.value = volume;
        updateSliderFill(volumeSlider);
    }
}

// NEW CLEANER IMPLEMENTATION - Setup audio volume controls
function setupVolumeControl() {
    // Get the volume slider
    const slider = document.getElementById('global-volume');
    if (!slider) {
        console.error("Volume slider not found in DOM");
        return;
    }
    
    // Verify it's not the heatmap slider
    if (slider.id === 'heatmap-intensity') {
        console.error("Wrong slider found - got heatmap slider instead of volume");
        return;
    }
    
    // Clear any existing listeners by replacing the element
    const newSlider = slider.cloneNode(true);
    if (slider.parentNode) {
        slider.parentNode.replaceChild(newSlider, slider);
    } else {
        console.error("Slider has no parent node");
        return;
    }
    
    // Set initial values
    newSlider.value = globalVolumeLevel;
    updateSliderFill(newSlider);
    
    // Add a single event handler for volume changes
    const volumeChangeHandler = function(e) {
        // Just call our global volume setter
        setGlobalVolume(parseFloat(this.value));
        
        // Update the slider fill
        updateSliderFill(this);
        
        // Prevent event bubbling
        e.stopPropagation();
    };
    
    // Add only the input and change events (no mouseup/touchend)
    newSlider.addEventListener('input', volumeChangeHandler);
    newSlider.addEventListener('change', volumeChangeHandler);
}

// --- NEW Live Feed Helper Functions ---

// Shows/hides the main live feed display area based on selections
function updateLiveFeedDisplayVisibility() {
    if (!liveFeedDisplayContainer) return;
    liveFeedDisplayContainer.style.display = liveFeedSelectedTalkgroups.size > 0 ? 'flex' : 'none';
    // Optional: Clear display if no TGs are selected and it's being hidden
    if (liveFeedSelectedTalkgroups.size === 0) {
        liveFeedDisplayContainer.innerHTML = '';
    }
}

// Updates the corresponding checkbox in the Live Feed setup modal
function updateLiveFeedModalCheckbox(talkgroupId, isSelected) {
    const modalCheckbox = document.querySelector(`#live-feed-modal #live-feed-tg-${talkgroupId}`);
    if (modalCheckbox) {
        modalCheckbox.checked = isSelected;
    }
}

// --- NEW: Scroll Handling Functions --- 
function handleTalkgroupScroll() {
    const listElement = document.getElementById('talkgroup-list');
    if (!listElement) return;

    // Calculate how close to bottom: scrollHeight - currentScrollTop <= clientHeight + threshold
    const scrollThreshold = 200; // Pixels from bottom to trigger load
    const nearBottom = listElement.scrollHeight - listElement.scrollTop <= listElement.clientHeight + scrollThreshold;

    // console.log(`Scroll check: nearBottom=${nearBottom}, isLoading=${isLoadingMoreTalkgroupCalls}, hasMore=${hasMoreTalkgroupCalls}, isSearching=${isSearchingForTargetCall}`);

    if (nearBottom && !isLoadingMoreTalkgroupCalls && hasMoreTalkgroupCalls && !isSearchingForTargetCall) {
        console.log('[TalkgroupModal] Reached bottom, fetching more calls...');
        fetchMoreTalkgroupCalls();
    }
}

function fetchMoreTalkgroupCalls() {
    if (!currentOpenTalkgroupId) return; // Should not happen, but safety check

    isLoadingMoreTalkgroupCalls = true;
    const listElement = document.getElementById('talkgroup-list');
    
    // Add loading indicator
    const loadingIndicator = document.createElement('div');
    loadingIndicator.className = 'loading-placeholder';
    loadingIndicator.textContent = 'Loading more...';
    if (listElement) listElement.appendChild(loadingIndicator);

    const nextOffset = currentTalkgroupOffset; // Offset is the number of items already loaded
    const fetchUrl = `/api/talkgroup/${currentOpenTalkgroupId}/calls?limit=${talkgroupPageLimit}&offset=${nextOffset}`;
    console.log(`[TalkgroupModal] Fetching next page: ${fetchUrl}`);

    fetch(fetchUrl)
        .then(response => response.json())
        .then(calls => {
            if (calls && calls.length > 0) {
                calls.forEach(call => {
                    const listItem = createTalkgroupListItem(call);
                    if (listElement) listElement.appendChild(listItem);
                });
                // Update offset
                currentTalkgroupOffset += calls.length;
                // Check if there might be more
                hasMoreTalkgroupCalls = calls.length === talkgroupPageLimit;
            } else {
                // No more calls returned
                hasMoreTalkgroupCalls = false;
                if (listElement) {
                    loadingIndicator.textContent = 'End of history.';
                    // Optionally remove the indicator after a delay
                    setTimeout(() => loadingIndicator.remove(), 3000);
                }
            }
        })
        .catch(error => {
            console.error('Error fetching more talkgroup calls:', error);
            if (loadingIndicator) loadingIndicator.textContent = 'Error loading more.';
             hasMoreTalkgroupCalls = false; // Stop trying on error
        })
        .finally(() => {
            isLoadingMoreTalkgroupCalls = false;
            // Remove loading indicator unless it was changed to "End of history" or "Error"
             if (loadingIndicator && loadingIndicator.textContent === 'Loading more...') {
                 loadingIndicator.remove();
             }
        });
}
// --- END NEW: Scroll Handling Functions ---

// NEW: User Location Feature
function setupUserLocationButton() {
    const LocationControl = L.Control.extend({
        options: {
            position: 'topright' // CHANGED to topright
        },
        onAdd: function (mapInstance) {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control-custom');
            container.id = 'location-control-container'; // ADD THIS LINE
            this._mapInstance = mapInstance; // Store map reference

            // Initialize control-specific state variables
            this.isUserLocationActive = false; // ADDED
            this.hasCenteredOnUserLocation = false; // ADDED
            this.userLocationMarker = null; // ADDED
            this.userLocationWatchId = null; // ADDED
            // REMOVED: this._isProcessingClick = false;

            this._locationButton = L.DomUtil.create('a', 'location-button', container);
            // Ensure NO INLINE FILL on the path, CSS will control it.
            this._locationButton.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12,8A4,4 0 0,0 8,12A4,4 0 0,0 12,16A4,4 0 0,0 16,12A4,4 0 0,0 12,8M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4Z" /></svg>';
            this._locationButton.href = '#';
            this._locationButton.role = 'button';
            this._locationButton.title = 'Toggle My Location';

            // Store the bound function for adding/removing listener
            this._boundToggleUserLocation = this._toggleUserLocation.bind(this);

            L.DomEvent.on(this._locationButton, 'click', L.DomEvent.stopPropagation)
                      .on(this._locationButton, 'click', L.DomEvent.preventDefault)
                      .on(this._locationButton, 'click', this._boundToggleUserLocation, this) // USE BOUND HANDLER
                      .on(this._locationButton, 'dblclick', L.DomEvent.stopPropagation);
            return container;
        },

        _toggleUserLocation: function () {
            // REMOVED _isProcessingClick check
            console.log('[LocationControl] _toggleUserLocation called. isUserLocationActive:', this.isUserLocationActive);

            if (this.isUserLocationActive) { 
                this._stopWatchingLocation();
            } else {
                this._startWatchingLocation();
            }
            // REMOVED setTimeout for _isProcessingClick
        },

        _startWatchingLocation: function () {
            console.log('[LocationControl] _startWatchingLocation called.'); 
            if (navigator.geolocation) {
                this.hasCenteredOnUserLocation = false; // CHANGED to this.
                const options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };
                this.userLocationWatchId = navigator.geolocation.watchPosition( // CHANGED to this.
                    (position) => this._updateUserLocationDisplay(position),
                    (error) => this._handleLocationError(error),
                    options
                );
                this.isUserLocationActive = true; // CHANGED to this.
                L.DomUtil.addClass(this._locationButton, 'active');
                console.log('[LocationControl] Added "active" class. Button classes:', this._locationButton.className);
                showNotification('Tracking your location...', 'success');
            } else {
                showNotification('Geolocation is not supported by your browser.', 'error');
                this._stopWatchingLocation(); 
                // this._isProcessingClick = false; // Already handled by setTimeout in _toggleUserLocation
            }
        },

        _stopWatchingLocation: function () {
            console.log('[LocationControl] _stopWatchingLocation CALLED (Top of function)'); 
            console.log('[LocationControl] At stop: userLocationWatchId is:', this.userLocationWatchId);
            console.log('[LocationControl] At stop: userLocationMarker is:', this.userLocationMarker);

            if (navigator.geolocation && this.userLocationWatchId !== null) { 
                console.log('[LocationControl] Attempting to clear watch ID:', this.userLocationWatchId);
                navigator.geolocation.clearWatch(this.userLocationWatchId); 
                console.log('[LocationControl] Geolocation watch clearWatch called.'); // Confirms clearWatch was called
            } else {
                console.log('[LocationControl] Skipped clearWatch. Has geolocation? ', navigator.geolocation, 'Watch ID null? ', this.userLocationWatchId === null);
            }

            if (this.userLocationMarker) { 
                console.log('[LocationControl] userLocationMarker exists. Attempting to remove from map.');
                if (this._mapInstance && this._mapInstance.hasLayer(this.userLocationMarker)) { 
                    this._mapInstance.removeLayer(this.userLocationMarker); 
                    console.log('[LocationControl] User location marker removeLayer called.'); // Confirms removeLayer was called
                } else {
                    console.log('[LocationControl] Skipped removeLayer. Map instance? ', !!this._mapInstance, 'Marker on map? ', this._mapInstance ? this._mapInstance.hasLayer(this.userLocationMarker) : 'N/A');
                }
                this.userLocationMarker = null; 
                console.log('[LocationControl] userLocationMarker set to null.');
            } else {
                console.log('[LocationControl] userLocationMarker was null or undefined already.');
            }

            this.userLocationWatchId = null; 
            this.isUserLocationActive = false; 
            if (this._locationButton) { 
              L.DomUtil.removeClass(this._locationButton, 'active');
              console.log('[LocationControl] Removed "active" class. Button classes:', this._locationButton.className);
            } else {
              console.log('[LocationControl] _stopWatchingLocation: _locationButton not found.');
            }
        },

        _updateUserLocationDisplay: function (position) {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;

            if (!this._mapInstance) return; 

            if (!this.userLocationMarker) { 
                const userLocationIcon = L.icon.userLocationPulse({
                    iconSize: [16, 16], 
                    color: '#007bff', 
                    heartbeat: 1.2 
                });
                this.userLocationMarker = L.marker([lat, lon], { 
                    icon: userLocationIcon, 
                    zIndexOffset: 2000, 
                    interactive: false
                }).addTo(this._mapInstance);
            } else {
                this.userLocationMarker.setLatLng([lat, lon]); 
            }

            if (!this.hasCenteredOnUserLocation) { 
                console.log('[LocationControl] Centering map. Disabling button click temporarily.');

                this._mapInstance.setView([lat, lon], USER_LOCATION_ZOOM_LEVEL);
                this.hasCenteredOnUserLocation = true; 

                // The block that was here, starting with a commented-out
                // "this._mapInstance.once('zoomend', ...)", should be deleted.
            }
        },
        // ... (rest of LocationControl methods are fine)
        _handleLocationError: function (error) {
            console.error('[LocationControl] _handleLocationError CALLED:', error.code, error.message);
            let message = 'Error getting location: ';
            switch (error.code) {
                case error.PERMISSION_DENIED:
                    message = "Geolocation permission denied. Please enable it in your browser settings.";
                    break;
                case error.POSITION_UNAVAILABLE:
                    message += "Location information is unavailable.";
                    break;
                case error.TIMEOUT:
                    message += "The request to get user location timed out.";
                    break;
                case error.UNKNOWN_ERROR:
                    message += "An unknown error occurred.";
                    break;
            }
            showNotification(message, 'error');
            console.error(message, error);
            this._stopWatchingLocation(); 
        },
        
        onRemove: function(mapInstance) {
            this._stopWatchingLocation();
        }
    });

    if (map) { 
        map.addControl(new LocationControl());
        console.log("[App] User Location Control added to map.");
    } else {
        console.error("[App] Map not initialized, cannot add User Location Control.");
    }
}
// END NEW: User Location Feature

// Call Purge Modal Functions
function setupCallPurgeModal() {
    const callPurgeModal = document.getElementById('call-purge-modal');
    const purgeTalkgroupSearch = document.getElementById('purge-talkgroup-search');
    const purgeTalkgroupList = document.getElementById('purge-talkgroup-list');
    const purgeCategorySelect = document.getElementById('purge-category-select');
    const purgeCustomTimeToggle = document.getElementById('purge-custom-time-toggle');
    const purgeCustomTimeInputs = document.getElementById('purge-custom-time-inputs');
    const purgeConfirmBtn = document.getElementById('purge-confirm-btn');
    
    // Initialize category dropdown
    populatePurgeCategoryDropdown();
    
    // Initialize talkgroup list
    populatePurgeTalkgroupList();
    
    // Search functionality
    if (purgeTalkgroupSearch) {
        purgeTalkgroupSearch.addEventListener('input', handlePurgeTalkgroupSearch);
    }
    
    // Custom time toggle
    if (purgeCustomTimeToggle) {
        purgeCustomTimeToggle.addEventListener('change', function() {
            purgeCustomTimeInputs.style.display = this.checked ? 'block' : 'none';
        });
    }
    
    // Time preset buttons
    document.querySelectorAll('.time-preset-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            // Remove active class from all buttons
            document.querySelectorAll('.time-preset-btn').forEach(b => b.classList.remove('active'));
            // Add active class to clicked button
            this.classList.add('active');
            
            // Set custom time inputs to hidden
            purgeCustomTimeToggle.checked = false;
            purgeCustomTimeInputs.style.display = 'none';
        });
    });
    
    // Purge confirm button
    if (purgeConfirmBtn) {
        purgeConfirmBtn.addEventListener('click', executeCallPurge);
    }
    
    // Undo last purge button
    const undoLastPurgeBtn = document.getElementById('undo-last-purge-btn');
    if (undoLastPurgeBtn) {
        undoLastPurgeBtn.addEventListener('click', undoLastPurge);
    }
    
    // Set default date/time values
    setDefaultPurgeDateTime();
}

function showCallPurgeModal() {
    const modal = document.getElementById('call-purge-modal');
    if (modal) {
        // Check if user has admin access when auth is enabled
        if (authEnabled && !isAdminUser) {
            alert('Admin access required to purge calls.');
            return;
        }
        
        modal.style.display = 'block';
        populatePurgeTalkgroupList();
        setDefaultPurgeDateTime();
        
        // Reset form state
        document.querySelectorAll('.time-preset-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('purge-custom-time-toggle').checked = false;
        document.getElementById('purge-custom-time-inputs').style.display = 'none';
        
        // Check if undo is available
        checkUndoAvailability();
    }
}

function populatePurgeCategoryDropdown() {
    const categorySelect = document.getElementById('purge-category-select');
    if (!categorySelect) return;
    
    // Clear existing options
    categorySelect.innerHTML = '<option value="">All Categories</option>';
    
    // Fetch categories from the API
    fetch('/api/categories')
        .then(response => response.json())
        .then(categories => {
            categories.forEach(category => {
                const option = document.createElement('option');
                option.value = category;
                option.textContent = category;
                categorySelect.appendChild(option);
            });
        })
        .catch(error => {
            console.error('Error loading categories for purge:', error);
            // Fallback to existing categories if API fails
            Object.keys(categoryCounts).forEach(category => {
                const option = document.createElement('option');
                option.value = category;
                option.textContent = category;
                categorySelect.appendChild(option);
            });
        });
}

function populatePurgeTalkgroupList() {
    const talkgroupList = document.getElementById('purge-talkgroup-list');
    if (!talkgroupList) return;
    
    talkgroupList.innerHTML = '<div class="loading-placeholder">Loading talkgroups...</div>';
    
    fetch('/api/talkgroups')
        .then(response => response.json())
        .then(talkgroups => {
            if (talkgroups.length === 0) {
                talkgroupList.innerHTML = '<div class="loading-placeholder">No talkgroups found.</div>';
                return;
            }
            
            talkgroupList.innerHTML = `
                <div class="purge-talkgroup-item">
                    <input type="checkbox" id="purge-tg-all" data-tg-id="all" />
                    <label for="purge-tg-all"><strong>All Talkgroups</strong></label>
                </div>
                <hr style="margin: 8px 0; border: none; border-top: 1px solid #ccc;">
                ${talkgroups.map(tg => `
                    <div class="purge-talkgroup-item">
                        <input type="checkbox" id="purge-tg-${tg.id}" data-tg-id="${tg.id}" class="individual-tg" />
                        <label for="purge-tg-${tg.id}">${tg.name}</label>
                    </div>
                `).join('')}
            `;
            
            // Add event listeners for "All Talkgroups" functionality
            const allTalkgroupsCheckbox = document.getElementById('purge-tg-all');
            const individualCheckboxes = document.querySelectorAll('.individual-tg');
            
            // When "All Talkgroups" is checked, uncheck individual ones
            allTalkgroupsCheckbox.addEventListener('change', function() {
                if (this.checked) {
                    individualCheckboxes.forEach(cb => cb.checked = false);
                }
            });
            
            // When individual talkgroup is checked, uncheck "All Talkgroups"
            individualCheckboxes.forEach(cb => {
                cb.addEventListener('change', function() {
                    if (this.checked) {
                        allTalkgroupsCheckbox.checked = false;
                    }
                });
            });
        })
        .catch(error => {
            console.error('Error loading talkgroups for purge:', error);
            talkgroupList.innerHTML = '<div class="loading-placeholder error">Error loading talkgroups.</div>';
        });
}

function handlePurgeTalkgroupSearch() {
    const searchInput = document.getElementById('purge-talkgroup-search');
    const talkgroupList = document.getElementById('purge-talkgroup-list');
    if (!searchInput || !talkgroupList) return;
    
    const searchTerm = searchInput.value.toLowerCase();
    const talkgroupItems = talkgroupList.querySelectorAll('.purge-talkgroup-item');
    
    talkgroupItems.forEach(item => {
        const label = item.querySelector('label');
        const text = label.textContent.toLowerCase();
        item.style.display = text.includes(searchTerm) ? 'block' : 'none';
    });
}

function setDefaultPurgeDateTime() {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    // Set default end date/time to now
    document.getElementById('purge-end-date').value = now.toISOString().split('T')[0];
    document.getElementById('purge-end-time').value = now.toTimeString().slice(0, 5);
    
    // Set default start date/time to 1 hour ago
    document.getElementById('purge-start-date').value = oneHourAgo.toISOString().split('T')[0];
    document.getElementById('purge-start-time').value = oneHourAgo.toTimeString().slice(0, 5);
}

async function executeCallPurge() {
    console.log('[DEBUG] executeCallPurge started');
    
    const selectedTalkgroups = Array.from(document.querySelectorAll('#purge-talkgroup-list input[type="checkbox"]:checked'))
        .map(cb => cb.dataset.tgId)
        .filter(id => id !== 'all'); // Filter out the "all" option since backend handles empty array as "all talkgroups"
    
    const selectedCategories = [];
    const categorySelect = document.getElementById('purge-category-select');
    if (categorySelect && categorySelect.value) {
        selectedCategories.push(categorySelect.value);
    }
    
    const timeRange = getSelectedTimeRange();
    
    console.log('[DEBUG] Selected talkgroups:', selectedTalkgroups);
    console.log('[DEBUG] Selected categories:', selectedCategories);
    console.log('[DEBUG] Time range:', timeRange);
    
    // Note: Empty selectedCategories means "All Categories" (no filter applied)
    // This is handled by the backend, so we don't need to validate against empty array
    
    if (!timeRange.start || !timeRange.end) {
        showNotification('Please select a valid time range', 'error');
        return;
    }
    
    // Convert to Unix timestamps (seconds)
    const startTime = Math.floor(new Date(timeRange.start).getTime() / 1000);
    const endTime = Math.floor(new Date(timeRange.end).getTime() / 1000);
    
    console.log('[DEBUG] Unix timestamps - start:', startTime, 'end:', endTime);
    
    try {
        // First, get the count of calls that would be affected
        const countParams = new URLSearchParams();
        if (selectedTalkgroups.length > 0) {
            countParams.append('talkgroupIds', selectedTalkgroups.join(','));
        }
        if (selectedCategories.length > 0) {
            countParams.append('categories', selectedCategories.join(','));
        }
        countParams.append('timeRangeStart', startTime);
        countParams.append('timeRangeEnd', endTime);
        
        console.log('[DEBUG] Count params:', countParams.toString());
        
        const countResponse = await fetch(`/api/calls/purge-count?${countParams.toString()}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...(authEnabled && currentSessionToken ? { 'Authorization': `Bearer ${currentSessionToken}` } : {})
            }
        });
        
        console.log('[DEBUG] Count response status:', countResponse.status);
        console.log('[DEBUG] Count response ok:', countResponse.ok);
        
        if (!countResponse.ok) {
            const errorText = await countResponse.text();
            console.log('[DEBUG] Count response error text:', errorText);
            throw new Error(`Failed to get call count: ${countResponse.status} ${countResponse.statusText}`);
        }
        
        const contentType = countResponse.headers.get('content-type');
        console.log('[DEBUG] Count response content-type:', contentType);
        
        if (!contentType || !contentType.includes('application/json')) {
            const responseText = await countResponse.text();
            console.log('[DEBUG] Count response non-JSON text:', responseText);
            throw new Error('Invalid response format from server');
        }
        
        const countData = await countResponse.json();
        console.log('[DEBUG] Count data received:', countData);
        
        const callCount = countData.count;
        console.log('[DEBUG] Call count:', callCount);
        
        if (callCount === 0) {
            showNotification('No calls found matching the selected criteria', 'success');
            return;
        }
        
        // Show custom confirmation modal
        const confirmed = await showPurgeConfirmation(callCount);
        console.log('[DEBUG] User confirmed:', confirmed);
        
        if (!confirmed) {
            console.log('[DEBUG] User cancelled, returning');
            return;
        }
        
        // Proceed with the purge
        console.log('[DEBUG] Proceeding with purge...');
        
        const purgeResponse = await fetch('/api/calls/purge', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(authEnabled && currentSessionToken ? { 'Authorization': `Bearer ${currentSessionToken}` } : {})
            },
            body: JSON.stringify({
                talkgroupIds: selectedTalkgroups,
                categories: selectedCategories,
                timeRangeStart: startTime,
                timeRangeEnd: endTime
            })
        });
        
        console.log('[DEBUG] Purge response status:', purgeResponse.status);
        
        if (!purgeResponse.ok) {
            const errorText = await purgeResponse.text();
            console.log('[DEBUG] Purge response error text:', errorText);
            throw new Error(`Purge failed: ${purgeResponse.status} ${purgeResponse.statusText}`);
        }
        
        const contentTypePurge = purgeResponse.headers.get('content-type');
        console.log('[DEBUG] Purge response content-type:', contentTypePurge);
        
        if (!contentTypePurge || !contentTypePurge.includes('application/json')) {
            const responseText = await purgeResponse.text();
            console.log('[DEBUG] Purge response non-JSON text:', responseText);
            throw new Error('Invalid response format from server during purge');
        }
        
        const purgeResult = await purgeResponse.json();
        console.log('[DEBUG] Purge result:', purgeResult);
        
        showNotification(`Successfully purged ${callCount} calls from the map`, 'success');
        
        // Check if undo is now available
        checkUndoAvailability();
        
        // Close the modal
        const modal = document.getElementById('call-purge-modal');
        if (modal) {
            modal.style.display = 'none';
        }
        
        // Reload the map to reflect changes
        console.log('[DEBUG] Reloading map...');
        console.log('[DEBUG] timeRangeHours:', timeRangeHours);
        console.log('[DEBUG] Calling loadCalls...');
        loadCalls(timeRangeHours);
        console.log('[DEBUG] Map reloaded');
        
    } catch (error) {
        console.error('[DEBUG] Error during purge process:', error);
        showNotification(`Error during purge process: ${error.message}`, 'error');
    }
}

// Show custom confirmation modal for purge operations
function showPurgeConfirmation(callCount) {
    return new Promise((resolve) => {
        const modal = document.getElementById('purge-confirmation-modal');
        const message = document.getElementById('purge-confirmation-message');
        const confirmBtn = document.getElementById('purge-confirm-yes');
        const cancelBtn = document.getElementById('purge-confirm-no');
        
        if (!modal || !message || !confirmBtn || !cancelBtn) {
            console.error('[DEBUG] Confirmation modal elements not found');
            resolve(false);
            return;
        }
        
        // Set the message
        message.textContent = `This will purge ${callCount} call${callCount !== 1 ? 's' : ''} from the map. Are you sure you want to continue?`;
        
        // Show the modal
        modal.style.display = 'block';
        
        // Set up event listeners
        const handleConfirm = () => {
            modal.style.display = 'none';
            cleanup();
            resolve(true);
        };
        
        const handleCancel = () => {
            modal.style.display = 'none';
            cleanup();
            resolve(false);
        };
        
        const handleModalClick = (e) => {
            if (e.target === modal) {
                handleCancel();
            }
        };
        
        const cleanup = () => {
            confirmBtn.removeEventListener('click', handleConfirm);
            cancelBtn.removeEventListener('click', handleCancel);
            modal.removeEventListener('click', handleModalClick);
        };
        
        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);
        modal.addEventListener('click', handleModalClick);
    });
}

function resetPurgeButton() {
    const confirmBtn = document.getElementById('purge-confirm-btn');
    if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Purge Calls';
    }
}

// Check if undo is available for the last purge operation
async function checkUndoAvailability() {
    const undoBtn = document.getElementById('undo-last-purge-btn');
    if (!undoBtn) return;
    
    try {
        const response = await fetch('/api/calls/can-undo-purge', {
            headers: {
                'Content-Type': 'application/json',
                ...(authEnabled && currentSessionToken ? { 'Authorization': `Bearer ${currentSessionToken}` } : {})
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            if (data.canUndo) {
                undoBtn.style.display = 'inline-block';
                undoBtn.disabled = false;
                undoBtn.title = data.message;
            } else {
                undoBtn.style.display = 'none';
            }
        } else {
            undoBtn.style.display = 'none';
        }
    } catch (error) {
        console.error('Error checking undo availability:', error);
        undoBtn.style.display = 'none';
    }
}

// Undo the last purge operation
async function undoLastPurge() {
    const undoBtn = document.getElementById('undo-last-purge-btn');
    if (!undoBtn) return;
    
    // Disable button during operation
    undoBtn.disabled = true;
    undoBtn.textContent = 'Undoing...';
    
    try {
        const response = await fetch('/api/calls/undo-last-purge', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(authEnabled && currentSessionToken ? { 'Authorization': `Bearer ${currentSessionToken}` } : {})
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            showNotification(data.message, 'success');
            
            // Hide the undo button
            undoBtn.style.display = 'none';
            
            // Reload the map to show restored calls
            loadCalls(timeRangeHours);
        } else {
            const errorData = await response.json();
            showNotification(`Error: ${errorData.error}`, 'error');
        }
    } catch (error) {
        console.error('Error undoing purge:', error);
        showNotification('Error undoing purge operation', 'error');
    } finally {
        // Re-enable button
        undoBtn.disabled = false;
        undoBtn.textContent = 'Undo Last Purge';
    }
}

function reloadMapAfterPurge() {
    // Clear existing markers
    Object.values(allMarkers).forEach(({ marker }) => {
        if (marker && map.hasLayer(marker)) {
            map.removeLayer(marker);
        }
    });
    
    // Clear marker groups
    if (markerGroups) {
        map.removeLayer(markerGroups);
        markerGroups = L.layerGroup();
        map.addLayer(markerGroups);
    }
    
    // Reset marker storage
    allMarkers = {};
    
    // Reload calls with current time range
    loadCalls(timeRangeHours);
}

function getSelectedTimeRange() {
    if (document.getElementById('purge-custom-time-toggle').checked) {
        // Custom time range
        const startDate = document.getElementById('purge-start-date').value;
        const startTime = document.getElementById('purge-start-time').value;
        const endDate = document.getElementById('purge-end-date').value;
        const endTime = document.getElementById('purge-end-time').value;
        
        if (!startDate || !startTime || !endDate || !endTime) {
            return null;
        }
        
        return {
            start: `${startDate}T${startTime}:00`,
            end: `${endDate}T${endTime}:00`
        };
    } else {
        // Preset time range
        const activePreset = document.querySelector('.time-preset-btn.active');
        if (!activePreset) {
            return null;
        }
        
        const hours = parseInt(activePreset.dataset.hours);
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);
        
        return {
            start: startTime.toISOString(),
            end: endTime.toISOString()
        };
    }
}


