import unittest
from urllib.parse import urlparse, parse_qs
from vehicle_dashboard import VehicleDashboard, DashboardError


class FakeTesla:
    def __init__(self):
        self.calls = []
        self.state = 'online'
        self.multiple = False
        self.fail_wake = False
        self.location = {'latitude': 0.0, 'longitude': 0.0, 'gps_as_of': 1780000000}

    def request(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if url.endswith('/vehicles'):
            vehicles = [{'vin': 'TEST-CAR-A'}]
            if self.multiple:
                vehicles.append({'vin': 'TEST-CAR-B'})
            return {'response': vehicles}
        if '/vehicle_data?' in url:
            return {'response': {'state': self.state, 'vin': 'TEST-CAR-A', 'charge_state': {'battery_level': 80}, 'drive_state': self.location}}
        if url.endswith('/wake_up'):
            if self.fail_wake:
                raise TimeoutError()
            return {'response': {'state': 'asleep'}}
        return {'response': {'state': self.state}}


class VehicleDashboardTests(unittest.TestCase):
    def setUp(self):
        self.tesla = FakeTesla()
        self.now = 100.0
        self.dashboard = VehicleDashboard('https://example.invalid', lambda: 'test-only-token', self.tesla.request, clock=lambda: self.now)

    def test_sleep_does_not_read_data_or_wake(self):
        self.tesla.state = 'asleep'
        self.assertEqual(self.dashboard.data(), {'response': {'state': 'asleep'}})
        self.assertFalse(any('/vehicle_data' in url or '/wake_up' in url for url, _ in self.tesla.calls))

    def test_cache_prevents_multiple_live_reads(self):
        self.dashboard.data()
        self.dashboard.data()
        self.assertEqual(sum('/vehicle_data?' in url for url, _ in self.tesla.calls), 1)
        self.now += 61
        self.dashboard.data()
        self.assertEqual(sum('/vehicle_data?' in url for url, _ in self.tesla.calls), 2)

    def test_response_filters_vehicle_identity(self):
        self.assertNotIn('vin', self.dashboard.data()['response'])
        self.assertEqual(self.dashboard.status(), {'response': {'state': 'online'}})

    def test_post_command_sync_is_bounded_and_restores_normal_cache(self):
        self.dashboard.data()
        self.dashboard.begin_command_sync()
        for _ in range(2):
            self.now += 6
            self.dashboard.data()
        self.now += 3
        self.dashboard.data()
        self.assertEqual(sum('/vehicle_data?' in url for url, _ in self.tesla.calls), 3)
        self.assertEqual(self.dashboard.command_sync_reads, 0)

    def test_early_confirmed_sync_keeps_snapshot_after_window_without_local_429(self):
        self.dashboard.begin_command_sync()
        self.dashboard.data()
        self.now += 31
        self.dashboard.data()
        self.assertEqual(sum('/vehicle_data?' in url for url, _ in self.tesla.calls), 1)
        self.now += 30
        self.dashboard.data()
        self.assertEqual(sum('/vehicle_data?' in url for url, _ in self.tesla.calls), 2)

    def test_post_command_sync_never_wakes_sleeping_vehicle(self):
        self.tesla.state = 'asleep'
        self.dashboard.begin_command_sync()
        self.dashboard.data()
        self.assertFalse(any('/vehicle_data?' in url or '/wake_up' in url for url, _ in self.tesla.calls))

    def test_location_endpoint_requested_and_coordinates_preserved(self):
        response = self.dashboard.data()['response']
        urls = [url for url, _ in self.tesla.calls if '/vehicle_data?' in url]
        endpoints = parse_qs(urlparse(urls[0]).query)['endpoints'][0].split(';')
        self.assertIn('location_data', endpoints)
        self.assertIn('drive_state', endpoints)
        self.assertEqual(response['drive_state'], self.tesla.location)
        self.assertNotIn('vin', response)

    def test_missing_location_remains_unknown_not_zero(self):
        self.tesla.location = {'shift_state': 'P'}
        response = self.dashboard.data()['response']
        self.assertNotIn('latitude', response['drive_state'])
        self.assertEqual(response['charge_state']['battery_level'], 80)

    def test_explicit_wake_posts_json_once(self):
        self.tesla.state = 'asleep'
        self.assertEqual(self.dashboard.wake(), {'accepted': True})
        with self.assertRaises(DashboardError) as error:
            self.dashboard.wake()
        self.assertEqual(error.exception.status, 429)
        wake = [(url, kwargs) for url, kwargs in self.tesla.calls if url.endswith('/wake_up')]
        self.assertEqual(len(wake), 1)
        self.assertEqual(wake[0][1]['json_body'], {})

    def test_uncertain_wake_is_not_sent_again(self):
        self.tesla.state = 'asleep'
        self.tesla.fail_wake = True
        with self.assertRaises(DashboardError):
            self.dashboard.wake()
        with self.assertRaises(DashboardError) as error:
            self.dashboard.wake()
        self.assertEqual(error.exception.status, 429)
        self.assertEqual(sum(url.endswith('/wake_up') for url, _ in self.tesla.calls), 1)

    def test_online_vehicle_not_woken(self):
        with self.assertRaises(DashboardError) as error:
            self.dashboard.wake()
        self.assertEqual(error.exception.status, 409)

    def test_multiple_vehicles_require_selection(self):
        self.tesla.multiple = True
        with self.assertRaises(DashboardError) as error:
            self.dashboard.status()
        self.assertEqual(error.exception.status, 409)

    def test_configured_vin_must_belong_to_account(self):
        dashboard = VehicleDashboard('https://example.invalid', lambda: 'fake', self.tesla.request, configured_vin='OTHER')
        with self.assertRaises(DashboardError):
            dashboard.status()

    def test_upstream_limit_blocks_followup(self):
        class Limited(RuntimeError):
            status = 429
            retry_after = 180
        self.dashboard.request = lambda *args, **kwargs: (_ for _ in ()).throw(Limited())
        with self.assertRaises(DashboardError) as error:
            self.dashboard.status()
        self.assertEqual(error.exception.retry_after, 180)
        self.now += 61
        with self.assertRaises(DashboardError) as error:
            self.dashboard.status()
        self.assertGreater(error.exception.retry_after, 100)


if __name__ == '__main__':
    unittest.main()
