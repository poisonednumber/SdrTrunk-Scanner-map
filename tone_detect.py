#!/usr/bin/env python3
"""
tone_detect.py - Two-tone and paging tone detection module
Integrates with icad-tone-detection library for scanner audio analysis
"""

import sys
import json
import logging
import os
import tempfile
from typing import Dict, Any, Optional, List
from pathlib import Path
from urllib.parse import urlparse

try:
    import boto3
    from botocore.exceptions import NoCredentialsError, ClientError
    BOTO3_AVAILABLE = True
except ImportError:
    BOTO3_AVAILABLE = False

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler(sys.stderr)]
)
logger = logging.getLogger(__name__)

try:
    from icad_tone_detection import tone_detect
    logger.info("✓ icad-tone-detection library loaded successfully")
except ImportError as e:
    logger.error(f"ERROR: icad-tone-detection not available: {e}")
    logger.error("Run: pip install icad-tone-detection")
    sys.exit(1)

def download_s3_file(s3_url: str) -> str:
    """Download file from S3 using credentials from environment"""
    if not BOTO3_AVAILABLE:
        raise ImportError("boto3 not available for S3 downloads")
    
    parsed_url = urlparse(s3_url)
    
    # Extract S3 details from URL: https://s3.kinetix.net/bucket-name/key
    endpoint_url = f"{parsed_url.scheme}://{parsed_url.netloc}/"
    path_parts = parsed_url.path.strip('/').split('/', 1)
    
    if len(path_parts) < 2:
        raise ValueError(f"Invalid S3 URL format: {s3_url}")
    
    bucket_name = path_parts[0]
    key = path_parts[1]
    
    logger.info(f"Downloading from S3: bucket={bucket_name}, key={key}")
    
    try:
        # Get S3 credentials from environment
        s3_client = boto3.client(
            's3',
            endpoint_url=endpoint_url,
            aws_access_key_id=os.getenv('S3_ACCESS_KEY_ID'),
            aws_secret_access_key=os.getenv('S3_SECRET_ACCESS_KEY'),
            region_name=os.getenv('S3_REGION', 'us-east-1')
        )
        
        # Create temporary file
        file_extension = Path(key).suffix or '.wav'
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=file_extension)
        temp_file.close()
        
        # Download file from S3
        s3_client.download_file(bucket_name, key, temp_file.name)
        
        file_size = os.path.getsize(temp_file.name)
        logger.info(f"Downloaded {file_size} bytes from S3 to {temp_file.name}")
        
        return temp_file.name
        
    except Exception as e:
        logger.error(f"Failed to download from S3: {e}")
        raise

class ToneDetector:
    """Two-tone detection wrapper for icad-tone-detection library"""
    
    def __init__(self, config: Dict[str, Any] = None):
        """Initialize tone detector with configuration"""
        self.config = config or {}
        
        # Read environment variables and merge with config (env vars take precedence)
        env_config = {}
        env_vars = [
            ('TONE_DETECTION_THRESHOLD', 'matching_threshold', float),
            ('TONE_TIME_RESOLUTION_MS', 'time_resolution_ms', int),
            ('TONE_FREQUENCY_BAND', 'fe_freq_band', str),
            ('TWO_TONE_MIN_TONE_LENGTH', 'tone_a_min_length', float),
            ('TWO_TONE_MAX_TONE_LENGTH', 'tone_b_min_length', float),
            ('TWO_TONE_MIN_PAIR_SEPARATION_HZ', 'two_tone_min_pair_separation_hz', int),
            ('TWO_TONE_BW_HZ', 'two_tone_bw_hz', int),
            ('PULSED_MIN_CYCLES', 'pulsed_min_cycles', int),
            ('PULSED_MIN_ON_MS', 'pulsed_min_on_ms', int),
            ('PULSED_MAX_ON_MS', 'pulsed_max_on_ms', int),
            ('PULSED_MIN_OFF_MS', 'pulsed_min_off_ms', int),
            ('PULSED_MAX_OFF_MS', 'pulsed_max_off_ms', int),
            ('PULSED_BANDWIDTH_HZ', 'pulsed_bw_hz', int),
            ('LONG_TONE_MIN_LENGTH', 'long_tone_min_length', float),
            ('LONG_TONE_BANDWIDTH_HZ', 'long_tone_bw_hz', int),
        ]
        
        for env_var, config_key, type_func in env_vars:
            env_value = os.getenv(env_var)
            if env_value is not None:
                try:
                    env_config[config_key] = type_func(env_value)
                    logger.info(f"Applied env var {env_var}={env_value} -> {config_key}={env_config[config_key]}")
                except (ValueError, TypeError):
                    logger.warning(f"Invalid value for {env_var}: {env_value}")
            else:
                logger.info(f"Env var {env_var} not set")
        
        # Merge: config takes precedence over env, env takes precedence over defaults
        self.config = {**env_config, **self.config}
        
        # Determine detection type from environment or config
        detection_type = os.getenv('TONE_DETECTION_TYPE', self.config.get('detection_type', 'auto'))
        
        # Configuration based on environment variables only - no fallback defaults
        if detection_type == 'auto':
            # Use library defaults - optimized for most scanner recordings
            self.default_config = {
                'detect_two_tone': True,
                'detect_pulsed': True,
                'detect_long': True,
                'detect_hi_low': False,  # Less common
                'detect_mdc': False,     # Less common
                'detect_dtmf': False,    # Less common
                # Use library defaults for all parameters - they work well for most cases
                'matching_threshold': 2.5,
                'time_resolution_ms': 50,
                'fe_freq_band': '200,3000',
                'fe_merge_short_gaps_ms': 0,
                'fe_silence_below_global_db': -28.0,
                'fe_snr_above_noise_db': 6.0,
                'fe_abs_cap_hz': 30,      # Fixed value to avoid None errors
                'fe_force_split_step_hz': 18,  # Fixed value for better separation
                'fe_split_lookahead_frames': 2,
                # Two-tone defaults
                'tone_a_min_length': 0.85,
                'tone_b_min_length': 2.6,
                'two_tone_bw_hz': 25,
                'two_tone_min_pair_separation_hz': 40,
                # Pulsed defaults
                'pulsed_min_cycles': 6,
                'pulsed_min_on_ms': 120,
                'pulsed_max_on_ms': 900,
                'pulsed_min_off_ms': 25,
                'pulsed_max_off_ms': 350,
                'pulsed_bw_hz': 25,
                # Long tone defaults (reduced to catch shorter dispatch tones like 0.97s)
                'long_tone_min_length': 0.5,
                'long_tone_bw_hz': 25
            }
        elif detection_type == 'long':
            self.default_config = {
                'detect_two_tone': False,
                'detect_pulsed': False,
                'detect_long': True,  # Enable long tone detection for continuous tones
                'detect_hi_low': False,
                'detect_mdc': False,
                'detect_dtmf': False,
                'long_tone_min_length': 0.5,
                'long_tone_bw_hz': 30,
                'time_resolution_ms': 25,
                'matching_threshold': 2.0,
                'fe_freq_band': '200,3000',
                # Fix for library bug - set these explicitly
                'fe_force_split_step_hz': 10,
                'fe_split_lookahead_frames': 0,
                'fe_abs_cap_hz': 2000,
                'fe_merge_short_gaps_ms': 0,
                'fe_silence_below_global_db': -28,
                'fe_snr_above_noise_db': 6
            }
        elif detection_type == 'pulsed':
            self.default_config = {
                'detect_two_tone': False,
                'detect_pulsed': True,  # Enable pulsed detection for short beeps
                'detect_long': False,
                'detect_hi_low': False,
                'detect_mdc': False,
                'detect_dtmf': False,
                'pulsed_min_cycles': 3,
                'pulsed_min_on_ms': 50,
                'pulsed_max_on_ms': 500,
                'pulsed_min_off_ms': 25,
                'pulsed_max_off_ms': 800,
                'pulsed_bw_hz': 50,
                'time_resolution_ms': 25,
                'matching_threshold': 2.0,
                'fe_freq_band': '200,3000',
                # Fix for library bug - set these explicitly
                'fe_force_split_step_hz': 10,
                'fe_split_lookahead_frames': 0,
                'fe_abs_cap_hz': 2000,
                'fe_merge_short_gaps_ms': 0,
                'fe_silence_below_global_db': -28,
                'fe_snr_above_noise_db': 6
            }
        elif detection_type == 'both':
            self.default_config = {
                'detect_two_tone': True,
                'detect_pulsed': True,  # Enable all types
                'detect_long': True,
                'detect_hi_low': False,
                'detect_mdc': False,
                'detect_dtmf': False,
                'tone_a_min_length': 0.85,
                'tone_b_min_length': 2.6,
                'two_tone_bw_hz': 25,
                'two_tone_min_pair_separation_hz': 40,
                'pulsed_min_cycles': 3,
                'pulsed_min_on_ms': 50,
                'pulsed_max_on_ms': 500,
                'pulsed_min_off_ms': 25,
                'pulsed_max_off_ms': 800,
                'pulsed_bw_hz': 50,
                'long_tone_min_length': 0.5,
                'long_tone_bw_hz': 30,
                'time_resolution_ms': 25,
                'matching_threshold': 2.0,
                'fe_freq_band': '200,3000',
                # Fix for library bug - set these explicitly
                'fe_force_split_step_hz': 10,
                'fe_split_lookahead_frames': 0,
                'fe_abs_cap_hz': 2000,
                'fe_merge_short_gaps_ms': 0,
                'fe_silence_below_global_db': -28,
                'fe_snr_above_noise_db': 6
            }
        else:  # 'two_tone' (traditional)
            self.default_config = {
                'detect_two_tone': True,
                'detect_pulsed': False,
                'detect_long': False,
                'detect_hi_low': False,
                'detect_mdc': False,
                'detect_dtmf': False,
                'tone_a_min_length': 0.85,
                'tone_b_min_length': 2.6,
                'two_tone_bw_hz': 25,
                'two_tone_min_pair_separation_hz': 40,
                'time_resolution_ms': 50,
                'matching_threshold': 2.5,
                'fe_freq_band': '200,3000',
                # Fix for library bug - set these explicitly
                'fe_force_split_step_hz': 10,
                'fe_split_lookahead_frames': 0,
                'fe_abs_cap_hz': 2000,
                'fe_merge_short_gaps_ms': 0,
                'fe_silence_below_global_db': -28,
                'fe_snr_above_noise_db': 6
            }
        
        # Apply user config over defaults
        self.detection_config = {**self.default_config, **self.config}
        
        logger.info(f"ToneDetector initialized with config: {self.detection_config}")
    
    def detect_tones_in_file(self, audio_file_path: str) -> Dict[str, Any]:
        """
        Detect two-tone sequences in an audio file
        
        Args:
            audio_file_path: Path to the audio file to analyze (local path or URL)
            
        Returns:
            Dictionary containing detection results
        """
        logger.info(f"Analyzing audio file for tones: {audio_file_path}")
        
        # Handle S3 URLs by downloading them first
        local_file_path = audio_file_path
        temp_file_created = False
        
        try:
            # Check if this is an S3 URL that needs downloading
            if audio_file_path.startswith('https://') and 's3' in audio_file_path:
                local_file_path = download_s3_file(audio_file_path)
                temp_file_created = True
                logger.info(f"Downloaded S3 file to: {local_file_path}")
            elif not audio_file_path.startswith(('http://', 'https://')):
                # For local files, verify they exist
                if not os.path.exists(audio_file_path):
                    return {
                        'error': f'Local audio file not found: {audio_file_path}',
                        'has_two_tone': False,
                        'file_path': audio_file_path
                    }
            # For non-S3 URLs, pass directly to icad-tone-detection
            
            logger.info(f"Analyzing audio file for two-tone: {audio_file_path}")
            
            # Try CLI approach first (more reliable)
            try:
                result = self._detect_with_cli(local_file_path)
                if result is not None:
                    return result
                logger.info("CLI approach failed, trying Python API...")
            except Exception as cli_error:
                logger.warning(f"CLI approach failed: {cli_error}")
            
            # Fallback to Python API
            try:
                # Call icad-tone-detection with our configuration
                result = tone_detect(
                    local_file_path,
                    **self.detection_config
                )
                
                # Parse the results - check both two-tone and pulsed
                has_tone = False
                tone_data = None
                detected_type = None
                
                # Check for two-tone results
                if hasattr(result, 'two_tone_result') and result.two_tone_result:
                    two_tone_data = result.two_tone_result
                    
                    if (hasattr(two_tone_data, 'calls') and 
                        two_tone_data.calls and 
                        len(two_tone_data.calls) > 0):
                        has_tone = True
                        tone_data = two_tone_data
                        detected_type = "two-tone"
                        
                        logger.info(f"Two-tone detected! Found {len(two_tone_data.calls)} calls")
                        
                        # Log details of detected calls
                        for i, call in enumerate(two_tone_data.calls):
                            if hasattr(call, 'tone_a') and hasattr(call, 'tone_b'):
                                logger.info(f"  Call {i+1}: Tone A = {call.tone_a:.1f}Hz, Tone B = {call.tone_b:.1f}Hz")
                
                # Check for long tone results if no two-tone found
                if not has_tone and hasattr(result, 'long_result') and result.long_result:
                    long_data = result.long_result
                    
                    if (hasattr(long_data, 'calls') and 
                        long_data.calls and 
                        len(long_data.calls) > 0):
                        has_tone = True
                        tone_data = long_data
                        detected_type = "long"
                        
                        logger.info(f"Long tone detected! Found {len(long_data.calls)} calls")
                        
                        # Log details of detected calls
                        for i, call in enumerate(long_data.calls):
                            if hasattr(call, 'frequency'):
                                duration = getattr(call, 'duration', 'unknown')
                                logger.info(f"  Call {i+1}: Frequency = {call.frequency:.1f}Hz, Duration = {duration}s")
                
                # Check for pulsed results if no other tone found
                if not has_tone and hasattr(result, 'pulsed_result') and result.pulsed_result:
                    pulsed_data = result.pulsed_result
                    
                    if (hasattr(pulsed_data, 'calls') and 
                        pulsed_data.calls and 
                        len(pulsed_data.calls) > 0):
                        has_tone = True
                        tone_data = pulsed_data
                        detected_type = "pulsed"
                        
                        logger.info(f"Pulsed tone detected! Found {len(pulsed_data.calls)} calls")
                        
                        # Log details of detected calls
                        for i, call in enumerate(pulsed_data.calls):
                            if hasattr(call, 'frequency'):
                                cycles = getattr(call, 'cycles', 'unknown')
                                logger.info(f"  Call {i+1}: Frequency = {call.frequency:.1f}Hz, Cycles = {cycles}")
                
                if not has_tone:
                    logger.info("No dispatch tones detected")
                
                result = {
                    'has_two_tone': has_tone,  # Keep same name for compatibility
                    'detection_result': tone_data,
                    'detected_type': detected_type,
                    'file_path': audio_file_path,
                    'config_used': self.detection_config
                }
                
                # Clean up temp file if we created one
                if temp_file_created and os.path.exists(local_file_path):
                    try:
                        os.unlink(local_file_path)
                        logger.info(f"Cleaned up temporary file: {local_file_path}")
                    except Exception:
                        pass  # Ignore cleanup errors
                
                return result
                
            except Exception as api_error:
                logger.error(f"Python API also failed: {api_error}")
                # Return a mock result indicating failure
                return {
                    'error': f"Both CLI and API failed. CLI: {cli_error if 'cli_error' in locals() else 'Not attempted'}, API: {api_error}",
                    'has_two_tone': False,
                    'file_path': audio_file_path
                }
            
        except Exception as e:
            error_msg = f"Error during tone detection: {str(e)}"
            logger.error(error_msg)
            
            # Clean up temp file if we created one
            if temp_file_created and os.path.exists(local_file_path):
                try:
                    os.unlink(local_file_path)
                    logger.info(f"Cleaned up temporary file: {local_file_path}")
                except Exception:
                    pass  # Ignore cleanup errors
            
            return {
                'error': error_msg,
                'has_two_tone': False,
                'file_path': audio_file_path
            }
    
    def _detect_with_cli(self, audio_file_path: str) -> Optional[Dict[str, Any]]:
        """Try detection using CLI interface (more reliable)"""
        import subprocess
        import json
        import tempfile
        
        try:
            # Create command arguments based on detection type
            cmd = [
                'icad-tone-detect',
                audio_file_path,
                '--detect_two_tone', str(self.detection_config.get('detect_two_tone', False)).lower(),
                '--detect_pulsed', str(self.detection_config.get('detect_pulsed', False)).lower(),
                '--detect_long', str(self.detection_config.get('detect_long', False)).lower(),
                '--detect_hi_low', 'false',
                '--detect_mdc', 'false',
                '--detect_dtmf', 'false',
                '--time_resolution_ms', str(self.detection_config.get('time_resolution_ms', 25)),
                '--matching_threshold', str(self.detection_config.get('matching_threshold', 2.0)),
                '--fe_freq_band', self.detection_config.get('fe_freq_band', '200,3000'),
                '--fe_force_split_step_hz', str(self.detection_config.get('fe_force_split_step_hz', 10)),
                '--fe_abs_cap_hz', str(self.detection_config.get('fe_abs_cap_hz', 2000))
            ]
            
            # Add two-tone specific parameters if enabled
            if self.detection_config.get('detect_two_tone', False):
                cmd.extend([
                    '--tone_a_min_length', str(self.detection_config.get('tone_a_min_length', 0.85)),
                    '--tone_b_min_length', str(self.detection_config.get('tone_b_min_length', 2.6)),
                    '--two_tone_bw_hz', str(self.detection_config.get('two_tone_bw_hz', 25)),
                    '--two_tone_min_pair_separation_hz', str(self.detection_config.get('two_tone_min_pair_separation_hz', 40))
                ])
            
            # Add pulsed specific parameters if enabled
            if self.detection_config.get('detect_pulsed', False):
                cmd.extend([
                    '--pulsed_min_cycles', str(self.detection_config.get('pulsed_min_cycles', 3)),
                    '--pulsed_min_on_ms', str(self.detection_config.get('pulsed_min_on_ms', 50)),
                    '--pulsed_max_on_ms', str(self.detection_config.get('pulsed_max_on_ms', 500)),
                    '--pulsed_min_off_ms', str(self.detection_config.get('pulsed_min_off_ms', 25)),
                    '--pulsed_max_off_ms', str(self.detection_config.get('pulsed_max_off_ms', 800)),
                    '--pulsed_bw_hz', str(self.detection_config.get('pulsed_bw_hz', 50))
                ])
            
            # Add long tone specific parameters if enabled
            if self.detection_config.get('detect_long', False):
                cmd.extend([
                    '--long_tone_min_length', str(self.detection_config.get('long_tone_min_length', 1.5)),
                    '--long_tone_bw_hz', str(self.detection_config.get('long_tone_bw_hz', 30))
                ])
            
            # Run the CLI command
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30  # 30 second timeout
            )
            
            if result.returncode == 0:
                # Parse JSON output for detection results
                output = result.stdout
                try:
                    json_output = json.loads(output)
                    
                    has_two_tone = len(json_output.get('two_tone', [])) > 0
                    has_pulsed = len(json_output.get('pulsed', [])) > 0
                    has_long = len(json_output.get('long_tone', [])) > 0
                    has_tone = has_two_tone or has_pulsed or has_long
                    
                    # Determine primary detected type (prioritize two-tone, then pulsed, then long)
                    detected_type = None
                    detected_types = []
                    if has_two_tone:
                        detected_types.append("two-tone")
                    if has_pulsed:
                        detected_types.append("pulsed")
                    if has_long:
                        detected_types.append("long")
                    
                    # Use first detected type as primary, or combine if multiple
                    if detected_types:
                        detected_type = detected_types[0] if len(detected_types) == 1 else "+".join(detected_types)
                
                except json.JSONDecodeError:
                    # Fallback to text parsing
                    has_two_tone = 'Two-tone' in output or 'two-tone' in output
                    has_pulsed = 'Pulsed' in output or 'pulsed' in output
                    has_long = 'Long' in output or 'long-tone' in output or 'long_tone' in output
                    has_tone = has_two_tone or has_pulsed or has_long
                    
                    detected_type = None
                    if has_two_tone:
                        detected_type = "two-tone"
                    elif has_pulsed:
                        detected_type = "pulsed"
                    elif has_long:
                        detected_type = "long"
                
                logger.info(f"CLI detection completed: {has_tone} ({detected_type if detected_type else 'none'})")
                if has_tone:
                    logger.info(f"CLI output: {output}")
                
                return {
                    'has_two_tone': has_tone,  # Keep same name for compatibility
                    'detection_result': {'cli_output': output},
                    'detected_type': detected_type,
                    'file_path': audio_file_path,
                    'method': 'cli'
                }
            else:
                logger.error(f"CLI detection failed: {result.stderr}")
                return None
                
        except subprocess.TimeoutExpired:
            logger.error("CLI detection timed out")
            return None
        except Exception as e:
            logger.error(f"CLI detection error: {e}")
            return None
    
    def get_detected_tones(self, detection_result: Dict[str, Any]) -> List[Dict[str, float]]:
        """
        Extract tone frequencies from detection result
        
        Args:
            detection_result: Result from detect_tones_in_file()
            
        Returns:
            List of detected tone pairs [{'tone_a': freq1, 'tone_b': freq2}, ...]
        """
        tones = []
        
        if not detection_result.get('has_two_tone', False):
            return tones
        
        two_tone_data = detection_result.get('detection_result')
        if not two_tone_data or not hasattr(two_tone_data, 'calls'):
            return tones
        
        for call in two_tone_data.calls:
            if hasattr(call, 'tone_a') and hasattr(call, 'tone_b'):
                tones.append({
                    'tone_a': float(call.tone_a),
                    'tone_b': float(call.tone_b),
                    'duration_a': getattr(call, 'duration_a', 0.0),
                    'duration_b': getattr(call, 'duration_b', 0.0)
                })
        
        return tones

def create_detector_from_env() -> ToneDetector:
    """Create a ToneDetector instance using environment variables from Node.js"""
    
    # These will be passed from the Node.js process via command line or stdin
    config = {}
    
    # We'll receive configuration from the parent process
    return ToneDetector(config)

def main():
    """Main function for standalone testing"""
    if len(sys.argv) < 2:
        print("Usage: python tone_detect.py <audio_file_path>", file=sys.stderr)
        sys.exit(1)
    
    audio_file = sys.argv[1]
    
    # Create detector with default configuration
    detector = ToneDetector()
    
    # Detect tones
    result = detector.detect_tones_in_file(audio_file)
    
    # Print results as JSON
    print(json.dumps(result, indent=2))
    
    # Get detected tone frequencies
    tones = detector.get_detected_tones(result)
    if tones:
        print(f"\nDetected {len(tones)} two-tone sequence(s):", file=sys.stderr)
        for i, tone_pair in enumerate(tones):
            print(f"  {i+1}: {tone_pair['tone_a']:.1f}Hz → {tone_pair['tone_b']:.1f}Hz", file=sys.stderr)

if __name__ == "__main__":
    main()
